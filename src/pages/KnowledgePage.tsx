import { useEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'react';
import { Alert, Badge, Button, Checkbox, Drawer, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Progress, Result, Select, Space, Steps, Table, Tabs, Tag, Tooltip, Upload, message } from 'antd';
import type { UploadProps } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, BookOutlined, CheckCircleFilled, CheckOutlined, CloudUploadOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, ExperimentOutlined, FileExcelOutlined, FileImageOutlined, FileMarkdownOutlined, FilePdfOutlined, FileTextOutlined, FileWordOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SettingOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { hub } from '../api';
import type { ChunkMode, DocumentMetadata, KnowledgeBase, KnowledgeDocument } from '../types';
import { formatDate, useWorkspace } from '../workspace';
import './knowledge.css';

const STATUS = {
  ready: { label: '已就绪', color: 'green' }, failed: { label: '构建失败', color: 'red' },
  queued: { label: '等待构建', color: 'default' }, indexing: { label: '索引中', color: 'blue' }, review: { label: '待确认', color: 'orange' },
} as const;
const METADATA_STATUS = {
  pending: { label: '等待抽取', color: 'default' }, draft: { label: '基础元数据', color: 'blue' },
  ready: { label: '模型已抽取', color: 'green' }, fallback: { label: '本机规则', color: 'orange' },
  edited: { label: '人工修订', color: 'purple' }, failed: { label: '抽取失败', color: 'red' },
} as const;
const ALLOWED = ['pdf', 'doc', 'docx', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'xlsx', 'xls', 'csv'];
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp'];
function kbColor(color: string) { return ({ blue: '#315ff4', violet: '#7c5ce4', teal: '#129b88' } as Record<string, string>)[color] || color; }
type ImportItem = { id: string; name: string; bytes: number; type: string; file?: File; serverId?: string; previewChunks?: string[]; metadata?: DocumentMetadata; metadataStatus?: string; error?: string };
type Snippet = { id: string; doc: KnowledgeDocument; index: number; content: string; score?: number; location?: string };
type KbFormValue = { name: string; description: string; category: string; tags: string[]; embeddingId: string; rerankId: string; chunkSize: number; overlap: number; chunkMode?: ChunkMode; chunkSeparator?: string };
const EMPTY_METADATA: DocumentMetadata = { documentDate: '', version: '', subjects: [], owners: [], keywords: [], questions: [] };
function documentMetadata(doc: { metadata?: DocumentMetadata }) { return doc.metadata || EMPTY_METADATA; }
function MetadataSummary({ metadata, status }: { metadata?: DocumentMetadata; status?: string }) {
  const value = metadata || EMPTY_METADATA;
  const rows = [
    ['时间', value.documentDate],
    ['版本', value.version],
    ['主体', value.subjects.join('、')],
    ['负责人', value.owners.join('、')],
    ['关键词', value.keywords.join('、')],
    ['可能的问题', value.questions.join('；')],
  ];
  return <section className="kb-metadata"><header><strong>检索元数据</strong>{status && <Tag color={METADATA_STATUS[status as keyof typeof METADATA_STATUS]?.color}>{METADATA_STATUS[status as keyof typeof METADATA_STATUS]?.label || status}</Tag>}</header><dl>{rows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text || '未识别'}</dd></div>)}</dl></section>;
}
const CHUNK_MODES: Array<{ value: ChunkMode; label: string; hint: string }> = [
  { value: 'length', label: '按长度', hint: '按字符长度切分，并尽量停在句子边界。' },
  { value: 'paragraph', label: '直接分段', hint: '优先按标题和段落合并到理想长度，超长再切开。代码块和表格尽量保持完整。' },
  { value: 'semantic', label: '语义拆分', hint: '先按标题切开。同一节里调用已测试通过的向量模型比较相邻句子，话题转开或超过理想长度时再切。' },
  { value: 'separator', label: '自定义分隔符', hint: '先按分隔符切开。只有某一段超过理想长度时，才继续切分。' },
  { value: 'qa', label: '问答拆分', hint: '文中已有问答应直接拆开。没有明确问答时，调用已测试通过的对话模型生成问答对，最多整理 6 段。' },
];
function ChunkModeControls({ mode, separator, onMode, onSeparator }: { mode: ChunkMode; separator: string; onMode: (mode: ChunkMode) => void; onSeparator: (value: string) => void }) {
  const current = CHUNK_MODES.find(item => item.value === mode);
  return <div className="kb-chunk-mode"><label className="kb-field-label">分块方式</label><Select aria-label="分块方式" value={mode} onChange={onMode} options={CHUNK_MODES.map(item => ({ value: item.value, label: item.label }))} />{mode === 'separator' ? <><label className="kb-field-label">自定义分隔符</label><Input aria-label="自定义分隔符" value={separator} maxLength={80} placeholder="例如 \\n\\n 、 --- 、 ###" onChange={event => onSeparator(event.target.value)} /></> : null}<p className="muted">{current?.hint}</p></div>;
}

function FileIcon({ type }: { type: string }) {
  const extension = type.toLowerCase();
  const icon = extension === 'pdf' ? <FilePdfOutlined /> : ['doc', 'docx'].includes(extension) ? <FileWordOutlined /> : ['xlsx', 'xls', 'csv'].includes(extension) ? <FileExcelOutlined /> : IMAGE_TYPES.includes(extension) ? <FileImageOutlined /> : ['md', 'markdown'].includes(extension) ? <FileMarkdownOutlined /> : <FileTextOutlined />;
  return <span className={`kb-file-icon kb-file-${extension}`}>{icon}</span>;
}
function sizeLabel(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function splitContent(content: string, size = 800, overlap = 80) {
  if (!content.trim()) return [];
  const output: string[] = [];
  const safeSize = Math.max(200, size);
  const safeOverlap = Math.max(0, Math.min(overlap, safeSize - 100));
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + safeSize);
    if (end < content.length) {
      const boundary = content.lastIndexOf('\n\n', end);
      if (boundary > start + safeSize * 0.5) end = boundary;
    }
    const text = content.slice(start, end).trim();
    if (text) output.push(text);
    if (end >= content.length) break;
    start = Math.max(start + 1, end - safeOverlap);
  }
  return output;
}
function documentChunks(doc: KnowledgeDocument) {
  if (doc.segments?.length) return doc.segments.map(segment => segment.content);
  return splitContent(doc.content);
}
export default function KnowledgePage() {
  const { state, setState, selectedKbId, setSelectedKbId, importSignal, consumeImport, navigate } = useWorkspace();
  const [api, messageContext] = message.useMessage();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [activeTab, setActiveTab] = useState('documents');
  const [documentSearch, setDocumentSearch] = useState('');
  const [documentStatus, setDocumentStatus] = useState('all');
  const [selectedDocs, setSelectedDocs] = useState<Key[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null);
  const [form] = Form.useForm<KbFormValue>();
  const [settingsForm] = Form.useForm<KbFormValue>();
  const [metadataForm] = Form.useForm<DocumentMetadata>();
  const [metadataDoc, setMetadataDoc] = useState<KnowledgeDocument | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [snippetSearch, setSnippetSearch] = useState('');
  const [source, setSource] = useState<Snippet | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [snippetText, setSnippetText] = useState('');
  const [testQuestion, setTestQuestion] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Snippet[] | null>(null);
  const [testLimit, setTestLimit] = useState(5);
  const [minimumScore, setMinimumScore] = useState(0);
  const [retrievalNote, setRetrievalNote] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState(0);
  const [importKbId, setImportKbId] = useState('');
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [chunkSize, setChunkSize] = useState(800);
  const [overlap, setOverlap] = useState(80);
  const [chunkMode, setChunkMode] = useState<ChunkMode>('paragraph');
  const [chunkSeparator, setChunkSeparator] = useState('');
  const [parseMode, setParseMode] = useState('auto');
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [building, setBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState(0);
  const [buildFinished, setBuildFinished] = useState(false);
  const [buildDocIds, setBuildDocIds] = useState<string[]>([]);
  const [previewFileId, setPreviewFileId] = useState('');
  const [rechunkDoc, setRechunkDoc] = useState<KnowledgeDocument | null>(null);
  const [rechunkSize, setRechunkSize] = useState(800);
  const [rechunkOverlap, setRechunkOverlap] = useState(80);
  const [rechunkMode, setRechunkMode] = useState<ChunkMode>('paragraph');
  const [rechunkSeparator, setRechunkSeparator] = useState('');
  const [rechunkChunks, setRechunkChunks] = useState<Array<{ content: string; location: string }> | null>(null);
  const [rechunking, setRechunking] = useState(false);
  const seenImportSignal = useRef(0);
  const canManage = state.role !== 'user';
  const kb = state.knowledgeBases.find(item => item.id === selectedKbId) || null;
  const kbDocs = state.documents.filter(doc => doc.kbId === kb?.id);
  const readyDocs = kbDocs.filter(doc => doc.status === 'ready');
  const previewDoc = state.documents.find(doc => doc.id === previewDocId);
  const embeddingModels = state.models.filter(model => model.kind === 'Embedding' && model.enabled);
  const rerankModels = state.models.filter(model => model.kind === 'Rerank' && model.enabled);
  const allSnippets = useMemo(() => kb ? state.documents.filter(doc => doc.kbId === kb.id && doc.status === 'ready').flatMap(doc => (doc.segments?.length ? doc.segments.map(segment => ({ id: `${doc.id}-${segment.index}`, doc, index: segment.index, content: segment.content, location: segment.location })) : documentChunks(doc).map((content, index) => ({ id: `${doc.id}-${index}`, doc, index, content })))) : [], [kb, state.documents]);
  const pendingChunks = useMemo(() => importItems.map(item => ({ item, chunks: item.previewChunks || [] })), [importItems]);
  const currentPreview = pendingChunks.find(item => item.item.id === previewFileId) || pendingChunks[0];

  useEffect(() => {
    if (importSignal === 0) { seenImportSignal.current = 0; return; }
    if (importSignal === seenImportSignal.current) return;
    seenImportSignal.current = importSignal;
    if (canManage) resetImport(selectedKbId || '');
    consumeImport();
  }, [importSignal, selectedKbId, canManage, consumeImport]);
  useEffect(() => { if (kb) settingsForm.setFieldsValue({ ...kb }); setSelectedDocs([]); setTestResults(null); setDocumentSearch(''); setDocumentStatus('all'); setActiveTab('documents'); }, [selectedKbId]);
  useEffect(() => { if (!canManage) { setEditorOpen(false); setImportOpen(false); setEditingSnippet(null); } }, [canManage]);

  function resetImport(targetId: string) {
    const target = state.knowledgeBases.find(item => item.id === targetId);
    setImportKbId(targetId || state.knowledgeBases[0]?.id || ''); setImportItems([]); setImportStep(0);
    setChunkSize(target?.chunkSize || 800); setOverlap(target?.overlap || 80); setChunkMode(target?.chunkMode || 'paragraph'); setChunkSeparator(target?.chunkSeparator || ''); setParseMode('auto');
    setParsing(false); setParseProgress(0); setBuilding(false); setBuildProgress(0); setBuildFinished(false); setBuildDocIds([]); setImportOpen(true);
  }
  function editKb(target?: KnowledgeBase) {
    if (!canManage) return;
    setEditingKb(target || null);
    form.setFieldsValue(target ? { ...target } : { name: '', description: '', category: '通用知识', tags: [], embeddingId: embeddingModels.find(model => model.isDefault)?.id || embeddingModels[0]?.id || '', rerankId: rerankModels.find(model => model.isDefault)?.id || '', chunkSize: 800, overlap: 80 });
    setEditorOpen(true);
  }
  function payloadFrom(values: KbFormValue) {
    return { name: values.name.trim(), description: values.description || '', category: values.category, tags: values.tags || [], embeddingId: values.embeddingId || '', rerankId: values.rerankId || '', chunkSize: values.chunkSize || 800, overlap: values.overlap || 0, chunkMode: values.chunkMode || 'length', chunkSeparator: values.chunkSeparator || '' };
  }
  async function saveKb() {
    if (!canManage) return;
    try {
      const input = await form.validateFields();
      const values = payloadFrom(input);
      if (state.knowledgeBases.some(item => item.name === values.name && item.id !== editingKb?.id)) { api.warning('已存在同名知识库，请使用其他名称'); return; }
      const next = editingKb ? await hub.updateKb(editingKb.id, values) : await hub.createKb(values);
      setState(next);
      if (!editingKb) setSelectedKbId(next.knowledgeBases.find(item => item.name === values.name)?.id || null);
      setEditorOpen(false); api.success(editingKb ? '知识库信息已保存' : '知识库已创建，可以开始导入资料');
    } catch (error) { if (error instanceof Error && error.message !== 'Validation failed') api.error(error.message); }
  }
  async function deleteKb(target: KnowledgeBase) {
    if (!canManage) return;
    try {
      setState(await hub.deleteKb(target.id));
      if (selectedKbId === target.id) setSelectedKbId(null);
      api.success('知识库已删除，对话与日志已保留');
    } catch (error) { api.error(error instanceof Error ? error.message : '删除失败'); }
  }
  async function deleteDocuments(ids: string[]) {
    if (!canManage) return;
    try {
      setState(await hub.deleteDocs(ids));
      setSelectedDocs([]); setTestResults(null); api.success(`已删除 ${ids.length} 份文档，历史引用将标记为失效`);
    } catch (error) { api.error(error instanceof Error ? error.message : '删除失败'); }
  }
  async function retryDocument(doc: KnowledgeDocument) {
    if (!canManage) return;
    try { setState(await hub.retry(doc.id)); api.info('已重新提交构建'); }
    catch (error) { api.error(error instanceof Error ? error.message : '重试失败'); }
  }
  function openRechunk(doc: KnowledgeDocument) {
    if (!canManage || !kb) return;
    setRechunkDoc(doc);
    setRechunkSize(kb.chunkSize || 800);
    setRechunkOverlap(kb.overlap || 80);
    setRechunkMode(kb.chunkMode || 'paragraph');
    setRechunkSeparator(kb.chunkSeparator || '');
    setRechunkChunks(null);
  }
  async function runRechunk(save: boolean) {
    if (!rechunkDoc) return;
    if (rechunkOverlap >= rechunkSize) { api.warning('重叠长度需要小于分块长度'); return; }
    if (rechunkMode === 'separator' && !rechunkSeparator.trim()) { api.warning('请填写自定义分隔符'); return; }
    try {
      setRechunking(true);
      const result = await hub.rechunk(rechunkDoc.id, { chunkSize: rechunkSize, overlap: rechunkOverlap, chunkMode: rechunkMode, chunkSeparator: rechunkSeparator, save });
      setRechunkChunks(result.chunks);
      if (save) {
        setState(result.state);
        setRechunkDoc(null);
        api.success('已按新的分段重新构建');
      }
    } catch (error) { api.error(error instanceof Error ? error.message : '修改分段失败'); }
    finally { setRechunking(false); }
  }
  async function runTest(question = testQuestion) {
    if (!kb || !question.trim()) { api.warning('请先输入要测试的问题'); return; }
    if (!readyDocs.length) { api.warning('当前没有已就绪的文档，请先完成知识构建'); return; }
    setTestQuestion(question); setTesting(true);
    try {
      const result = await hub.retrieve(kb.id, question.trim(), testLimit);
      const snippets: Snippet[] = [];
      result.hits.forEach(hit => {
        const doc = state.documents.find(item => item.id === hit.docId) || kbDocs.find(item => item.name === hit.title);
        if (!doc || hit.score < minimumScore) return;
        snippets.push({ id: `${hit.docId}-${hit.index}`, doc, index: hit.index, content: hit.content, score: hit.score, location: hit.location });
      });
      setTestResults(snippets);
      setRetrievalNote(result.note);
    } catch (error) { api.error(error instanceof Error ? error.message : '检索失败'); }
    finally { setTesting(false); }
  }
  const uploadProps: UploadProps = {
    multiple: true, accept: ALLOWED.map(ext => `.${ext}`).join(','), showUploadList: false, fileList: [],
    beforeUpload(file, batch) {
      const type = file.name.split('.').pop()?.toLowerCase() || '';
      if (!ALLOWED.includes(type)) { api.error(`${file.name}：暂不支持该文件格式`); return Upload.LIST_IGNORE; }
      const max = IMAGE_TYPES.includes(type) ? 20 : 50;
      if (file.size > max * 1024 * 1024) { api.error(`${file.name}：文件大小不能超过 ${max} MB`); return Upload.LIST_IGNORE; }
      if (importItems.length + batch.length > 20) { if (file.uid === batch[0]?.uid) api.error('单次最多导入 20 份文件，请减少文件数量后重试'); return Upload.LIST_IGNORE; }
      setImportItems(previous => previous.some(item => item.name === file.name && item.bytes === file.size) ? previous : [...previous, { id: file.uid, name: file.name, bytes: file.size, type, file }].slice(0, 20));
      return false;
    },
  };
  function addSamples() {
    const markdown = new File(['# 假期与报销\n\n年假需提前 3 个工作日提交申请，由直属负责人审批。\n\n出差结束后 30 个自然日内提交报销，需附已审批的出差申请、交通票据和住宿发票。\n'], '假期与报销制度.md', { type: 'text/markdown' });
    const csv = new File(['问题类型,处理方式,负责团队\n忘记密码,引导用户通过绑定邮箱重置密码,客户支持\n功能不可用,收集截图并建立技术工单,技术支持\n'], '服务处理指引.csv', { type: 'text/csv' });
    const samples = [markdown, csv].map(file => ({ id: file.name, name: file.name, bytes: file.size, type: file.name.split('.').pop() || 'txt', file }));
    setImportItems(previous => [...previous, ...samples.filter(item => !previous.some(existing => existing.name === item.name))].slice(0, 20));
    api.success('示例文件已加入，解析时会读取真实内容');
  }
  async function parseFiles() {
    if (!canManage) return;
    if (overlap >= chunkSize) { api.warning('重叠长度需要小于分块长度'); return; }
    if (chunkMode === 'separator' && !chunkSeparator.trim()) { api.warning('请填写自定义分隔符'); return; }
    const files = importItems.filter(item => item.file);
    if (!files.length) { api.warning('请选择要导入的文件'); return; }
    setParsing(true); setParseProgress(30);
    const form = new FormData();
    form.append('kbId', importKbId); form.append('chunkSize', String(chunkSize)); form.append('overlap', String(overlap)); form.append('chunkMode', chunkMode); form.append('chunkSeparator', chunkSeparator); form.append('parseMode', parseMode);
    files.forEach(item => form.append('files', item.file as File, item.name));
    try {
      const result = await hub.preview(form);
      setState(result.state);
      setImportItems(previous => previous.map(item => {
        const match = result.documents.find(doc => doc.name === item.name);
        return match ? { ...item, serverId: match.id, error: match.error || undefined, previewChunks: match.chunks.map(chunk => `${chunk.location}\n${chunk.content}`), metadata: match.metadata, metadataStatus: match.metadataStatus } : item;
      }));
      setPreviewFileId(files[0]?.id || '');
      setParseProgress(100);
      const failed = result.documents.filter(doc => doc.status === 'failed');
      if (failed.length === result.documents.length) {
        api.warning(failed.map(doc => `${doc.name}：${doc.error}`).join('；'));
        return;
      }
      setImportStep(2);
      if (failed.length) api.warning(failed.map(doc => `${doc.name}：${doc.error}`).join('；'));
    } catch (error) { api.error(error instanceof Error ? error.message : '解析失败'); }
    finally { setParsing(false); }
  }
  async function buildFiles() {
    if (!canManage || !state.knowledgeBases.some(item => item.id === importKbId)) { api.error('目标知识库已不存在，请重新选择'); return; }
    const ids = importItems.map(item => item.serverId).filter((id): id is string => Boolean(id) && !importItems.find(item => item.serverId === id)?.error);
    if (!ids.length) { api.warning('没有可构建的解析结果'); return; }
    setBuildDocIds(ids); setImportStep(3); setBuilding(true); setBuildProgress(40);
    try {
      setState(await hub.build(ids));
      setBuildProgress(100); setBuildFinished(true); api.success('已开始构建，完成后文档状态会变为已就绪');
    } catch (error) { api.error(error instanceof Error ? error.message : '构建失败'); }
    finally { setBuilding(false); }
  }
  async function saveSettings() {
    if (!canManage || !kb) return;
    try {
      const input = await settingsForm.validateFields();
      const values = payloadFrom(input);
      if (values.overlap >= values.chunkSize) { api.warning('重叠长度需要小于分块长度'); return; }
      if (state.knowledgeBases.some(item => item.id !== kb.id && item.name === values.name)) { api.warning('已存在同名知识库'); return; }
      setState(await hub.updateKb(kb.id, values));
      api.success('知识库设置已保存');
    } catch (error) { if (error instanceof Error && !error.message.includes('validate')) api.error(error.message); }
  }
  async function saveSnippet() {
    if (!canManage || !editingSnippet || !kb || !snippetText.trim()) return;
    try {
      setState(await hub.editChunk(editingSnippet.doc.id, editingSnippet.index, snippetText.trim()));
      setEditingSnippet(null); setTestResults(null); api.success('片段已更新，正在重新构建索引');
    } catch (error) { api.error(error instanceof Error ? error.message : '保存失败'); }
  }

  function editMetadata(doc: KnowledgeDocument) {
    if (!canManage) return;
    setMetadataDoc(doc);
    metadataForm.setFieldsValue(documentMetadata(doc));
  }
  async function saveMetadata() {
    if (!metadataDoc || !canManage) return;
    try {
      setMetadataSaving(true);
      const values = await metadataForm.validateFields();
      setState(await hub.updateMetadata(metadataDoc.id, values));
      setMetadataDoc(null);
      api.success('元数据已保存，正在更新检索索引');
    } catch (error) {
      if (error instanceof Error && !error.message.includes('validate')) api.error(error.message);
    } finally { setMetadataSaving(false); }
  }
  async function reextractMetadata(doc: KnowledgeDocument) {
    if (!canManage) return;
    try {
      setState(await hub.extractMetadata(doc.id));
      api.success('已提交元数据重新抽取与索引更新');
    } catch (error) { api.error(error instanceof Error ? error.message : '重新抽取失败'); }
  }

  const filteredKbs = state.knowledgeBases.filter(item => `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.updatedAt.localeCompare(a.updatedAt));
  const visibleDocs = kbDocs.filter(doc => doc.name.toLowerCase().includes(documentSearch.toLowerCase()) && (documentStatus === 'all' || doc.status === documentStatus));
  const docColumns = [
    { title: '文档名称', key: 'name', render: (_: unknown, doc: KnowledgeDocument) => <button className="kb-document-name" onClick={() => setPreviewDocId(doc.id)}><FileIcon type={doc.type} /><span><strong>{doc.name}</strong><small>{doc.sourceLabel}</small></span></button> },
    { title: '状态', key: 'status', width: 120, render: (_: unknown, doc: KnowledgeDocument) => <Tag color={STATUS[doc.status].color}>{STATUS[doc.status].label}</Tag> },
    { title: '元数据', key: 'metadata', width: 120, render: (_: unknown, doc: KnowledgeDocument) => <Tag color={METADATA_STATUS[doc.metadataStatus]?.color || 'default'}>{METADATA_STATUS[doc.metadataStatus]?.label || '未抽取'}</Tag> },
    { title: '大小', dataIndex: 'size', key: 'size', width: 90 },
    { title: '片段', dataIndex: 'chunks', key: 'chunks', width: 80, render: (value: number) => value.toLocaleString() },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 145, render: (value: string) => <span className="muted">{formatDate(value)}</span> },
    { title: '操作', key: 'actions', width: 280, render: (_: unknown, doc: KnowledgeDocument) => <Space size={4}><Button type="text" size="small" onClick={() => setPreviewDocId(doc.id)}>查看</Button>{canManage && <><Button type="text" size="small" onClick={() => editMetadata(doc)}>元数据</Button><Button type="text" size="small" disabled={doc.status === 'indexing'} onClick={() => openRechunk(doc)}>修改分段</Button><Tooltip title={doc.status === 'indexing' ? '构建进行中' : '按当前知识库分段重新构建'}><Button type="text" size="small" aria-label={`重新构建${doc.name}`} disabled={doc.status === 'indexing'} icon={<ReloadOutlined />} onClick={() => retryDocument(doc)} /></Tooltip><Popconfirm title="删除这份文档？" description="历史对话与日志保留，引用将显示来源失效。" onConfirm={() => deleteDocuments([doc.id])}><Button type="text" size="small" danger aria-label={`删除${doc.name}`} icon={<DeleteOutlined />} /></Popconfirm></>}</Space> },
  ];

  function renderDocuments() {
    return <div className="kb-tab-panel"><div className="kb-table-toolbar"><div className="kb-filter-group"><Input allowClear placeholder="搜索文档名称" prefix={<SearchOutlined />} value={documentSearch} onChange={event => setDocumentSearch(event.target.value)} /><Select aria-label="文档状态" value={documentStatus} onChange={setDocumentStatus} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(STATUS).map(([value, item]) => ({ value, label: item.label }))]} /></div>{canManage && <Space>{selectedDocs.length > 0 && <Popconfirm title={`删除所选 ${selectedDocs.length} 份文档？`} description="历史引用保留，来源将标记为失效。" onConfirm={() => deleteDocuments(selectedDocs.map(String))}><Button danger icon={<DeleteOutlined />}>删除所选</Button></Popconfirm>}<Button type="primary" icon={<PlusOutlined />} onClick={() => resetImport(kb!.id)}>导入知识</Button></Space>}</div>{kbDocs.length ? <Table rowKey="id" columns={docColumns} dataSource={visibleDocs} rowSelection={canManage ? { selectedRowKeys: selectedDocs, onChange: setSelectedDocs } : undefined} pagination={{ pageSize: 8, showSizeChanger: false, showTotal: total => `共 ${total} 份文档` }} scroll={{ x: 1180 }} locale={{ emptyText: <Empty description="没有找到符合条件的文档" /> }} /> : <div className="kb-large-empty"><span className="kb-empty-art"><CloudUploadOutlined /></span><h3>把分散的资料，变成可问的知识</h3><p>上传文档、图片或表格，预览分段结果后完成构建。</p>{canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={() => resetImport(kb!.id)}>导入第一份知识</Button> : <span className="muted">等待知识库管理人员导入资料</span>}</div>}</div>;
  }
  function renderTasks() {
    const pending = kbDocs.filter(doc => doc.status !== 'ready');
    return <div className="kb-tab-panel"><div className="kb-panel-intro"><div><h3>构建任务</h3><p>查看每份文档的处理状态，定位失败原因并重新构建。</p></div><Tag color="blue">{pending.length} 个待处理</Tag></div><Alert showIcon type="info" title="构建在本机进行。未配置向量模型时只建立关键词索引。" />{kbDocs.length ? <div className="kb-task-list">{[...kbDocs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(doc => <div className="kb-task" key={doc.id}><FileIcon type={doc.type} /><div className="kb-task-content"><strong>{doc.name}</strong><span className="muted">{formatDate(doc.updatedAt)} · {doc.chunks} 个片段</span>{doc.error && <p className="kb-error">{doc.error}</p>}<Progress percent={doc.status === 'ready' ? 100 : doc.status === 'indexing' ? 60 : doc.status === 'failed' ? 45 : 0} size="small" status={doc.status === 'failed' ? 'exception' : doc.status === 'indexing' ? 'active' : 'normal'} showInfo={false} /></div><Tag color={STATUS[doc.status].color}>{STATUS[doc.status].label}</Tag>{canManage && doc.status !== 'ready' && doc.status !== 'indexing' && <Button icon={<ReloadOutlined />} onClick={() => retryDocument(doc)}>重新构建</Button>}<Button type="text" onClick={() => setPreviewDocId(doc.id)}>查看详情</Button></div>)}</div> : <Empty className="kb-empty" description="导入知识后，构建任务将显示在这里" />}</div>;
  }
  function renderSnippets() {
    const visible = allSnippets.filter(item => `${item.content} ${item.doc.name}`.includes(snippetSearch));
    return <div className="kb-tab-panel"><div className="kb-table-toolbar"><div><h3>知识片段 <span className="muted">{allSnippets.length}</span></h3><p className="muted">已就绪文档的分段，可检查即将用于检索的内容。</p></div><Input className="kb-snippet-search" allowClear prefix={<SearchOutlined />} placeholder="搜索片段内容" value={snippetSearch} onChange={event => setSnippetSearch(event.target.value)} /></div>{visible.length ? <div className="kb-snippet-grid">{visible.map(item => <article className="kb-snippet" key={item.id}><header><span className="kb-snippet-number">分块 {String(item.index + 1).padStart(2, '0')}</span><span className="muted">{item.content.length} 字符</span></header><p>{item.content}</p><footer><span title={item.doc.name}><FileTextOutlined /> {item.doc.name}</span><Space size={2}><Button type="text" size="small" onClick={() => setSource(item)}>查看</Button>{canManage && <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditingSnippet(item); setSnippetText(item.content); }}>编辑</Button>}</Space></footer></article>)}</div> : <Empty className="kb-empty" description={allSnippets.length ? '没有找到匹配的片段' : '文档构建就绪后，可以在这里检查知识片段'} />}</div>;
  }
  function renderRetrieval() {
    return <div className="kb-retrieval"><section className="kb-test-config"><div className="kb-panel-intro"><div><span className="kb-section-eyebrow">RETRIEVAL TEST</span><h3>先确认找得到，再让回答更可靠</h3><p>输入一个业务问题，检查知识库召回的内容。</p></div></div><Alert type="info" showIcon title={retrievalNote || "检索已连接本机知识库"} description="已配置并通过测试的向量或重排模型会参与召回；否则使用关键词检索。" /><label className="kb-field-label" htmlFor="retrieval-question">测试问题</label><Input.TextArea id="retrieval-question" value={testQuestion} onChange={event => setTestQuestion(event.target.value)} placeholder="例如：员工请假需要怎么申请？" rows={4} maxLength={500} showCount /><div className="kb-quick-queries">{['请假如何申请？', '报销需要哪些资料？', '如何查看工单进度？'].map(question => <button key={question} onClick={() => setTestQuestion(question)}>{question}</button>)}</div><div className="kb-test-parameters"><div><label className="kb-field-label">结果数量</label><Select aria-label="检索结果数量" value={testLimit} onChange={setTestLimit} options={[3, 5, 10].map(value => ({ value, label: `${value} 个片段` }))} /></div><div><label className="kb-field-label">最低匹配分</label><InputNumber aria-label="最低匹配分" value={minimumScore} min={0} max={1} step={0.05} onChange={value => setMinimumScore(value ?? 0)} /></div></div><Button type="primary" block size="large" icon={<ExperimentOutlined />} loading={testing} onClick={() => runTest()}>开始检索测试</Button><div className="kb-test-note"><BookOutlined /> 检索范围：{kb?.name} · {readyDocs.length} 份已就绪文档</div></section><section className="kb-test-results"><div className="kb-test-result-heading"><h3>召回结果</h3>{testResults && <Tag>{testResults.length} 个片段 · 本次检索</Tag>}</div>{testResults === null ? <div className="kb-test-empty"><SearchOutlined /><h4>在这里检查知识是否命中</h4><p>输入问题后，你将看到相关片段、来源及匹配分。</p></div> : testResults.length ? <div className="kb-result-list">{testResults.map((item, index) => <button className="kb-result" key={item.id} onClick={() => setSource(item)}><header><span className="kb-result-rank">{index + 1}</span><strong>{item.doc.name}</strong><Tag color="blue">匹配分 {item.score?.toFixed(2)}</Tag></header><p>{item.content}</p><footer>第 {item.index + 1} 个片段 <span>查看引用 <ArrowRightOutlined /></span></footer></button>)}</div> : <Empty className="kb-empty" description={<span>未找到匹配内容<br /><small>可换一种问法、降低匹配分，或补充相关资料。</small></span>} />}</section></div>;
  }
  function basicFields(targetForm: 'editor' | 'settings') {
    return <><Form.Item name="name" label="知识库名称" rules={[{ required: true, whitespace: true, message: '请输入知识库名称' }, { max: 40, message: '名称最多 40 个字符' }]}><Input placeholder="例如：企业制度知识库" maxLength={40} /></Form.Item><Form.Item name="description" label="知识库说明"><Input.TextArea placeholder="介绍这份知识库的内容和适用范围" rows={3} maxLength={200} showCount /></Form.Item><div className="kb-form-two"><Form.Item name="category" label="知识分类" rules={[{ required: true, message: '请选择分类' }]}><Select options={['通用知识', '制度规范', '产品文档', '业务知识', '企业制度', '产品资料', '客户服务', '技术文档', '其他'].map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="tags" label="标签"><Select mode="tags" placeholder="输入后按回车添加" maxCount={5} options={['内部资料', '常用知识', '入职必读', '业务支持'].map(value => ({ value, label: value }))} /></Form.Item></div>{targetForm === 'settings' && <div className="kb-settings-divider"><h3>检索与分段</h3><p className="muted">这里保存知识库默认分段。改某一份已有文档，请在文档列表点「修改分段」。</p></div>}<div className="kb-form-two"><Form.Item name="embeddingId" label="Embedding 模型"><Select placeholder="暂未配置，可稍后设置" allowClear options={embeddingModels.map(model => ({ value: model.id, label: `${model.name} · ${model.provider}` }))} /></Form.Item><Form.Item name="rerankId" label="Rerank 模型"><Select placeholder="暂不启用" allowClear options={rerankModels.map(model => ({ value: model.id, label: `${model.name} · ${model.provider}` }))} /></Form.Item></div>{targetForm === 'settings' && <><Form.Item name="chunkMode" label="分块方式"><Select aria-label="分块方式" options={CHUNK_MODES.map(item => ({ value: item.value, label: item.label }))} /></Form.Item><Form.Item name="chunkSeparator" label="自定义分隔符"><Input aria-label="自定义分隔符" maxLength={80} placeholder="自定义分隔符时填写，例如 \\n\\n 或 ---" /></Form.Item><div className="kb-form-two"><Form.Item name="chunkSize" label="分块长度（字符）" rules={[{ required: true }]}><InputNumber min={300} max={2000} step={100} /></Form.Item><Form.Item name="overlap" label="重叠长度（字符）" rules={[{ required: true }]}><InputNumber min={0} max={300} step={20} /></Form.Item></div></>}</>;
  }

  return <div className="knowledge-page">{messageContext}
    {!kb ? <><div className="page-header"><div><span className="page-kicker">KNOWLEDGE WORKSPACE</span><h1>知识库</h1><p className="page-description">汇集企业知识，让每一次提问都有据可依。</p></div>{canManage && <Space><Button icon={<CloudUploadOutlined />} onClick={() => resetImport('')}>导入知识</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => editKb()}>新建知识库</Button></Space>}</div><div className="kb-overview"><div><span className="kb-overview-icon"><BookOutlined /></span><span><small>知识库总数</small><strong>{state.knowledgeBases.length}<em>个</em></strong></span></div><div><span className="kb-overview-icon teal"><FileTextOutlined /></span><span><small>已就绪文档</small><strong>{state.documents.filter(doc => doc.status === 'ready').length}<em>份</em></strong></span></div><div><span className="kb-overview-icon violet"><UnorderedListOutlined /></span><span><small>知识片段</small><strong>{state.documents.filter(doc => doc.status === 'ready').reduce((total, doc) => total + doc.chunks, 0).toLocaleString()}<em>个</em></strong></span></div><div className="kb-overview-helper"><CheckCircleFilled /><span>知识持续沉淀<br /><small>导入、检查、构建，一步步形成可用知识</small></span></div></div><div className="kb-list-toolbar"><div className="kb-list-heading"><h2>全部知识库</h2><span>{state.knowledgeBases.length}</span></div><Space><Input allowClear prefix={<SearchOutlined />} placeholder="搜索知识库或标签" value={query} onChange={event => setQuery(event.target.value)} /><Select aria-label="知识库排序" value={sort} onChange={setSort} options={[{ value: 'recent', label: '最近更新' }, { value: 'name', label: '名称排序' }]} /></Space></div>{filteredKbs.length ? <div className="kb-grid">{filteredKbs.map(item => { const docs = state.documents.filter(doc => doc.kbId === item.id); const complete = docs.filter(doc => doc.status === 'ready'); const failed = docs.filter(doc => doc.status === 'failed'); return <article className="kb-card" key={item.id}><div className="kb-card-top"><span className="kb-card-symbol" style={{ color: kbColor(item.color), background: `${kbColor(item.color)}12` }}><BookOutlined /></span><Tag>{item.category}</Tag>{canManage && <Dropdown trigger={['click']} menu={{ items: [{ key: 'edit', label: '编辑信息', icon: <EditOutlined />, onClick: () => editKb(item) }, { key: 'import', label: '导入知识', icon: <CloudUploadOutlined />, onClick: () => resetImport(item.id) }] }}><Button className="kb-card-more" type="text" aria-label={`管理${item.name}`} icon={<EllipsisOutlined />} /></Dropdown>}</div><button className="kb-card-main" onClick={() => setSelectedKbId(item.id)}><h3>{item.name}</h3><p>{item.description || '添加知识资料，为团队建立可靠的问答依据。'}</p></button><div className="kb-card-tags">{item.tags.slice(0, 3).map(tag => <Tag key={tag}>{tag}</Tag>)}{!item.tags.length && <span className="muted">未添加标签</span>}</div><div className="kb-card-counts"><span><FileTextOutlined /> <strong>{docs.length}</strong> 份文档</span><span><UnorderedListOutlined /> <strong>{complete.reduce((total, doc) => total + doc.chunks, 0).toLocaleString()}</strong> 个片段</span></div><footer><span>{failed.length ? <Badge status="error" text={`${failed.length} 份文档待处理`} /> : complete.length ? <Badge status="success" text="知识已就绪" /> : <Badge status="default" text="等待导入资料" />}</span><Tooltip title={`更新于 ${formatDate(item.updatedAt)}`}><span>{formatDate(item.updatedAt).split(' ')[0]} 更新</span></Tooltip></footer><button className="kb-card-open" aria-label={`打开${item.name}`} onClick={() => setSelectedKbId(item.id)}><ArrowRightOutlined /></button></article>; })}{canManage && !query && <button className="kb-create-card" onClick={() => editKb()}><span><PlusOutlined /></span><strong>新建知识库</strong><p>按部门、主题或业务场景整理知识</p></button>}</div> : <div className="surface kb-large-empty"><FolderOpenOutlined className="kb-empty-icon" /><h3>{query ? '没有找到相关知识库' : '从第一份知识库开始'}</h3><p>{query ? '试试其他关键词，或清空搜索条件。' : '为企业资料创建一个有序的知识空间。'}</p>{canManage && !query && <Button type="primary" onClick={() => editKb()}>新建知识库</Button>}</div>}</> : <><Button className="kb-back" type="text" icon={<ArrowLeftOutlined />} onClick={() => setSelectedKbId(null)}>全部知识库</Button><div className="page-header kb-detail-header"><div className="kb-detail-title"><span className="kb-card-symbol" style={{ color: kbColor(kb.color), background: `${kbColor(kb.color)}12` }}><BookOutlined /></span><div><div className="kb-detail-name"><h1>{kb.name}</h1><Tag>{kb.category}</Tag></div><p className="page-description">{kb.description || '把企业资料转化为可检索、可问答的知识。'}</p></div></div><Space><Button icon={<ExperimentOutlined />} onClick={() => { setActiveTab('retrieval'); }}>检索测试</Button><Button type="primary" icon={<BookOutlined />} disabled={!readyDocs.length} onClick={() => navigate('chat', kb.id)}>开始对话</Button></Space></div><div className="kb-detail-metrics"><span><FileTextOutlined /> <strong>{kbDocs.length}</strong> 份文档</span><span><CheckCircleFilled /> <strong>{readyDocs.length}</strong> 份已就绪</span><span><UnorderedListOutlined /> <strong>{readyDocs.reduce((total, doc) => total + doc.chunks, 0)}</strong> 个知识片段</span><span className="kb-detail-updated">更新于 {formatDate(kb.updatedAt)}</span></div><div className="surface kb-detail-surface"><Tabs activeKey={activeTab} onChange={setActiveTab} items={[{ key: 'documents', label: <span><FileTextOutlined /> 文档 <span className="kb-tab-count">{kbDocs.length}</span></span>, children: renderDocuments() }, { key: 'tasks', label: <span><ReloadOutlined /> 构建任务{kbDocs.some(doc => doc.status !== 'ready') && <Badge className="kb-tab-dot" dot />}</span>, children: renderTasks() }, { key: 'snippets', label: <span><UnorderedListOutlined /> 知识片段</span>, children: renderSnippets() }, { key: 'retrieval', label: <span><ExperimentOutlined /> 检索测试</span>, children: renderRetrieval() }, { key: 'settings', label: <span><SettingOutlined /> 知识库设置</span>, children: <div className="kb-settings"><Form form={settingsForm} layout="vertical" disabled={!canManage} initialValues={kb}>{basicFields('settings')}{canManage && <Button type="primary" onClick={saveSettings}>保存设置</Button>}</Form><div className="kb-danger-zone"><div><h3>删除知识库</h3><p>移除该库及库内文档。历史对话和日志保留，相关来源将显示失效。</p></div>{canManage ? <Popconfirm title={`确认删除“${kb.name}”？`} description="此操作会移除库内文档，不能从当前页面恢复。" onConfirm={() => deleteKb(kb)} okText="确认删除" okButtonProps={{ danger: true }}><Button danger>删除知识库</Button></Popconfirm> : <Tag>当前角色仅可查看</Tag>}</div></div> }]} /></div></>}
    <Modal open={editorOpen} title={editingKb ? '编辑知识库' : '新建知识库'} onCancel={() => setEditorOpen(false)} onOk={saveKb} okText={editingKb ? '保存修改' : '创建知识库'} width={620} destroyOnHidden><p className="kb-modal-description">按业务主题整理资料，创建后即可导入知识。</p><Form form={form} layout="vertical">{basicFields('editor')}<Form.Item name="chunkSize" hidden><InputNumber /></Form.Item><Form.Item name="overlap" hidden><InputNumber /></Form.Item></Form></Modal>
    <Modal className="kb-import-modal" open={importOpen} title={<div><CloudUploadOutlined /> 导入知识</div>} width={920} onCancel={() => { if (parsing || building) { api.info('任务正在处理，请等待完成'); return; } setImportOpen(false); }} maskClosable={false} footer={null} destroyOnHidden><div className="kb-import-intro">从资料到可用知识，先检查内容，再完成构建。</div><Steps current={importStep} size="small" items={[{ title: '选择文件' }, { title: '解析与分段' }, { title: '预览分块' }, { title: '构建完成' }]} /><div className="kb-import-body">{importStep === 0 && <><Alert className="kb-demo-alert" type="info" showIcon title="文件会上传到本机服务" description="Markdown、Word、Excel 和可提取文字的 PDF 在本机解析。图片、扫描件和旧版 Word 需要已测试通过的 DocMind。" /><label className="kb-field-label">导入到知识库</label><div className="kb-import-target"><Select aria-label="导入目标知识库" placeholder="请选择知识库" value={importKbId || undefined} onChange={value => { setImportKbId(value); const target = state.knowledgeBases.find(item => item.id === value); setChunkSize(target?.chunkSize || 800); setOverlap(target?.overlap || 80); }} options={state.knowledgeBases.map(item => ({ value: item.id, label: item.name }))} />{!state.knowledgeBases.length && <Button onClick={() => { setImportOpen(false); editKb(); }}>先创建知识库</Button>}</div><Upload.Dragger {...uploadProps} disabled={!importKbId}><p className="kb-upload-icon"><CloudUploadOutlined /></p><h3>点击选择文件，或将文件拖到这里</h3><p>Word、PDF、Markdown、图片、Excel / CSV</p><small>单次最多 20 份 · 文档不超过 50 MB · 图片不超过 20 MB</small></Upload.Dragger><div className="kb-demo-load"><span>想先试一条完整流程？</span><Button type="link" icon={<FileTextOutlined />} onClick={addSamples} disabled={!importKbId}>载入示例文件</Button></div>{importItems.length > 0 && <div className="kb-import-files"><div className="kb-import-files-heading"><strong>已选择 {importItems.length} 份文件</strong><Button type="text" size="small" onClick={() => setImportItems([])}>清空</Button></div>{importItems.map(item => <div className="kb-import-file" key={item.id}><FileIcon type={item.type} /><span className="kb-import-filename">{item.name}</span><span className="muted">{sizeLabel(item.bytes)}</span><Button type="text" aria-label={`移除${item.name}`} icon={<DeleteOutlined />} onClick={() => setImportItems(previous => previous.filter(file => file.id !== item.id))} /></div>)}</div>}</>}{importStep === 1 && <><Alert showIcon type="warning" title="下一步会把文件传到本机并解析。云端 OCR 只在选择该方式且 DocMind 可用时使用。" /><div className="kb-parser-layout"><section><h3>解析方式</h3><div className={`kb-parse-choice ${parseMode === 'auto' ? 'selected' : ''}`} onClick={() => !parsing && setParseMode('auto')} role="radio" aria-checked={parseMode === 'auto'} tabIndex={parsing ? -1 : 0} onKeyDown={event => { if (!parsing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setParseMode('auto'); } }}><CheckCircleFilled /><div><strong>自动识别 <Tag color="blue">推荐</Tag></strong><p>按文件类型在本机解析；扫描件和图片再交给 DocMind。</p></div></div><div className={`kb-parse-choice ${parseMode === 'ocr' ? 'selected' : ''}`} onClick={() => !parsing && setParseMode('ocr')} role="radio" aria-checked={parseMode === 'ocr'} tabIndex={parsing ? -1 : 0} onKeyDown={event => { if (!parsing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setParseMode('ocr'); } }}><FileImageOutlined /><div><strong>优先云端解析 <Tag>DocMind</Tag></strong><p>图片、扫描件和复杂版面走已配置的 DocMind。未配置时会提示失败。</p></div></div></section><section className="kb-chunk-controls"><h3>分段参数</h3><ChunkModeControls mode={chunkMode} separator={chunkSeparator} onMode={setChunkMode} onSeparator={setChunkSeparator} /><label className="kb-field-label">分块长度（字符）</label><InputNumber value={chunkSize} min={300} max={2000} step={100} disabled={parsing} onChange={value => setChunkSize(value || 800)} /><label className="kb-field-label">重叠长度（字符）</label><InputNumber value={overlap} min={0} max={300} step={20} disabled={parsing} onChange={value => setOverlap(value || 0)} /><p>适量重叠有助于保留上下文。分段按字符长度切分，并尽量停在段落边界。</p><Checkbox checked disabled>保留段落与标题结构</Checkbox></section></div>{parsing && <div className="kb-parse-progress"><span>正在解析文件…</span><Progress percent={parseProgress} /></div>}</>}{importStep === 2 && <><Alert showIcon type="warning" title="下面是本次解析出的分块，确认后再写入索引。" /><div className="kb-preview-heading"><div><h3>检查分块内容</h3><p className="muted">{importItems.length} 份文件 · {pendingChunks.reduce((total, item) => total + item.chunks.length, 0)} 个片段</p></div><Select aria-label="预览文件" value={currentPreview?.item.id} onChange={setPreviewFileId} options={importItems.map(item => ({ value: item.id, label: item.name }))} /></div><MetadataSummary metadata={currentPreview?.item.metadata} status={currentPreview?.item.metadataStatus} /><p className="muted">解析后先按本机规则生成这些字段，并在确认构建时写入检索索引。若已有通过测试的对话模型，构建时会再补全；模型失败则保留本机结果。引用仍使用原文片段。</p><div className="kb-import-chunks">{currentPreview?.chunks.length ? currentPreview.chunks.map((content, index) => <article key={`${currentPreview.item.id}-${index}`}><header><Tag>分块 {index + 1}</Tag><span className="muted">{content.length} 字符</span></header><p>{content}</p></article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={currentPreview?.item.error || '这次没有解析出可预览的片段'} />}</div><p className="kb-preview-tip"><CheckOutlined /> 确认后将创建本次检索文档，供在线对话与引用交互验收。</p></>}{importStep === 3 && <div className="kb-build-result">{buildFinished ? <Result status="success" title="构建任务已提交" subTitle={<span>已提交 {buildDocIds.length} 份文档。<br />状态变为已就绪后，即可检索和提问。</span>} /> : <><div className="kb-build-icon"><ReloadOutlined spin /></div><h2>正在提交构建…</h2><p>解析结果会进入索引队列。</p><Progress percent={buildProgress} status="active" /></>}<div className="kb-build-summary"><span>目标知识库<strong>{state.knowledgeBases.find(item => item.id === importKbId)?.name}</strong></span><span>导入文档<strong>{buildDocIds.length} 份</strong></span><span>索引<strong>本机解析结果</strong></span></div></div>}</div><div className="kb-import-footer"><span><span className="kb-local-dot" /> 原文件保存在本机</span><Space>{importStep < 3 && <Button disabled={parsing} onClick={() => importStep === 0 ? setImportOpen(false) : setImportStep(importStep - 1)}>{importStep === 0 ? '取消' : '上一步'}</Button>}{importStep === 0 && <Button type="primary" disabled={!importKbId || !importItems.length} onClick={() => setImportStep(1)}>下一步 <ArrowRightOutlined /></Button>}{importStep === 1 && <Button type="primary" loading={parsing} onClick={parseFiles}>解析并预览</Button>}{importStep === 2 && <Button type="primary" onClick={buildFiles}>确认并构建</Button>}{importStep === 3 && buildFinished && <><Button onClick={() => { setImportOpen(false); setSelectedKbId(importKbId); setActiveTab('documents'); }}>查看文档</Button><Button type="primary" onClick={() => { setImportOpen(false); setSelectedKbId(importKbId); setActiveTab('retrieval'); }}>去检索测试 <ArrowRightOutlined /></Button></>}</Space></div></Modal>
    <Drawer open={Boolean(previewDoc)} onClose={() => setPreviewDocId(null)} title="文档详情" size="large" styles={{ body: { padding: 28 } }}>{previewDoc && <><div className="kb-drawer-title"><FileIcon type={previewDoc.type} /><div><h2>{previewDoc.name}</h2><p className="muted">{previewDoc.size} · {previewDoc.chunks} 个片段 · {formatDate(previewDoc.updatedAt)}</p></div></div><div className="kb-document-meta"><Tag color={STATUS[previewDoc.status].color}>{STATUS[previewDoc.status].label}</Tag><Tag color={METADATA_STATUS[previewDoc.metadataStatus]?.color}>{METADATA_STATUS[previewDoc.metadataStatus]?.label || '未抽取'}</Tag><Tag>{previewDoc.sourceLabel}</Tag></div><MetadataSummary metadata={documentMetadata(previewDoc)} status={previewDoc.metadataStatus} />{previewDoc.metadataError && <Alert className="kb-drawer-alert" type="warning" showIcon title="元数据抽取已降级" description={previewDoc.metadataError} />}{canManage && <Space className="kb-metadata-actions"><Button onClick={() => editMetadata(previewDoc)}>修订元数据</Button><Button disabled={previewDoc.status === 'indexing' || previewDoc.status === 'review' || !previewDoc.chunks} onClick={() => void reextractMetadata(previewDoc)}>重新抽取</Button></Space>}{previewDoc.error && <Alert type="error" showIcon title="构建未完成" description={previewDoc.error} action={canManage ? <Button size="small" onClick={() => retryDocument(previewDoc)}>重新构建</Button> : undefined} />}<Alert className="kb-drawer-alert" type="info" showIcon title="解析结果" description="以下内容来自本机解析或 DocMind。它会作为检索和回答的依据。" /><h3>内容预览</h3><pre className="kb-content-preview">{previewDoc.content || '该文档尚未产生可预览内容，请完成构建后再查看。'}</pre></>}</Drawer>
    <Drawer open={Boolean(source)} onClose={() => setSource(null)} title="引用片段" size="large" styles={{ body: { padding: 28 } }}>{source && <><div className="kb-drawer-title"><FileIcon type={source.doc.type} /><div><h2>{source.doc.name}</h2><p className="muted">第 {source.index + 1} 个片段 · {source.content.length} 字符</p></div></div>{!state.documents.some(doc => doc.id === source.doc.id) && <Alert type="warning" showIcon title="来源已失效：这份文档已被删除" />}<Alert type="info" showIcon title={source.location || "引用片段"} description="这是构建时保存的片段。配置向量模型后，分数只用于排序。" /><div className="kb-source-highlight">{source.content}</div><Button icon={<FileTextOutlined />} disabled={!state.documents.some(doc => doc.id === source.doc.id)} onClick={() => { setSource(null); setPreviewDocId(source.doc.id); }}>查看完整文档</Button></>}</Drawer>
    <Modal open={Boolean(editingSnippet)} title="编辑知识片段" onCancel={() => setEditingSnippet(null)} onOk={saveSnippet} okText="保存片段" okButtonProps={{ disabled: !snippetText.trim() }} width={640}><Alert className="kb-drawer-alert" type="info" showIcon title="保存后会重新构建该文档的索引。" /><Input.TextArea aria-label="片段内容" rows={12} maxLength={5000} showCount value={snippetText} onChange={event => setSnippetText(event.target.value)} /></Modal>
    <Modal open={Boolean(rechunkDoc)} title={rechunkDoc ? `修改分段 · ${rechunkDoc.name}` : '修改分段'} width={720} onCancel={() => { if (!rechunking) setRechunkDoc(null); }} footer={<Space><Button disabled={rechunking} onClick={() => setRechunkDoc(null)}>取消</Button><Button loading={rechunking} onClick={() => void runRechunk(false)}>预览新分段</Button><Button type="primary" loading={rechunking} disabled={!rechunkChunks?.length} onClick={() => void runRechunk(true)}>确认并重新构建</Button></Space>}><p>选择分块方式并调整长度后，先预览，再重新构建这份文档。</p><ChunkModeControls mode={rechunkMode} separator={rechunkSeparator} onMode={mode => { setRechunkMode(mode); setRechunkChunks(null); }} onSeparator={value => { setRechunkSeparator(value); setRechunkChunks(null); }} /><div className="kb-form-two"><label className="kb-field-label">分块长度（字符）<InputNumber aria-label="分块长度" min={300} max={2000} step={100} value={rechunkSize} onChange={value => { setRechunkSize(value || 800); setRechunkChunks(null); }} /></label><label className="kb-field-label">重叠长度（字符）<InputNumber aria-label="重叠长度" min={0} max={300} step={20} value={rechunkOverlap} onChange={value => { setRechunkOverlap(value || 0); setRechunkChunks(null); }} /></label></div>{rechunkChunks ? <div className="kb-import-chunks kb-rechunk-preview">{rechunkChunks.map((chunk, index) => <article key={`${chunk.location}-${index}`}><header><Tag>分块 {index + 1}</Tag><span className="muted">{chunk.location}</span></header><p>{chunk.content}</p></article>)}</div> : <p className="muted">预览后会显示按新参数切出的片段，确认前不会改动当前索引。</p>}</Modal>
    <Modal open={Boolean(metadataDoc)} title={metadataDoc ? `检索元数据 · ${metadataDoc.name}` : '检索元数据'} onCancel={() => { if (!metadataSaving) setMetadataDoc(null); }} onOk={() => void saveMetadata()} confirmLoading={metadataSaving} okText={metadataDoc?.status === 'review' ? '保存' : '保存并更新索引'} width={720}><p>这些字段用于检索，不会替换原文片段。时间、版本、主体、负责人和关键词会跟正文一起进入索引。</p><Form form={metadataForm} layout="vertical"><div className="kb-form-two"><Form.Item name="documentDate" label="时间"><Input maxLength={80} placeholder="例如 2026-09-01" /></Form.Item><Form.Item name="version" label="版本"><Input maxLength={80} placeholder="例如 V1.2 或 2026版" /></Form.Item></div><Form.Item name="subjects" label="主体信息"><Select mode="tags" placeholder="输入后按回车添加" tokenSeparators={[',', '，']} /></Form.Item><Form.Item name="owners" label="负责人"><Select mode="tags" placeholder="负责人或负责部门" tokenSeparators={[',', '，']} /></Form.Item><Form.Item name="keywords" label="检索关键词"><Select mode="tags" placeholder="便于检索的关键词" tokenSeparators={[',', '，']} /></Form.Item><Form.Item name="questions" label="可能被问到的问题"><Select mode="tags" placeholder="用户可能会怎么问" tokenSeparators={[',', '，']} /></Form.Item></Form></Modal>
  </div>;
}
