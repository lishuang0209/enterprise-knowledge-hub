import { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, Modal, Result, Select, Space, Switch, Table, Tabs, Tag, Tooltip, message } from 'antd';
import type { InputRef } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiOutlined, CheckCircleOutlined, DeleteOutlined, EditOutlined, ExperimentOutlined, InfoCircleOutlined, PlusOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { hub } from '../api';
import type { ModelConfig, ModelKind } from '../types';
import { useWorkspace } from '../workspace';
import './operations.css';

type ConfigProvider = ModelConfig['provider'];
interface ModelFormValues {
  name: string; provider: ConfigProvider; kind: ModelKind; model: string; baseUrl: string;
  dimensions?: number; enabled: boolean; isDefault: boolean;
}
interface TestResult { ok: boolean; title: string; description: string }

const PROVIDERS: ConfigProvider[] = ['通义', 'OpenRouter', 'AIHubmix', 'DocMind'];
const KIND_NAMES: Record<ModelKind, string> = { LLM: '对话模型', Embedding: '向量模型', Rerank: '重排模型', OCR: '文档解析 / OCR' };
const KIND_DESCRIPTIONS: Record<ModelKind, string> = {
  LLM: '理解问题并根据资料生成回答，可单独选择对话供应商。',
  Embedding: '将资料与提问转换为向量。知识库构建后绑定其模型与维度。',
  Rerank: '对召回片段重新排序，提高交给对话模型的资料相关性。',
  OCR: '云端提取 Word、PDF、图片中的文字与表格，独立于模型服务配置。',
};
const PROVIDER_MARKS: Record<ConfigProvider, string> = { '通义': 'Q', OpenRouter: 'O', AIHubmix: 'A', DocMind: 'D' };
const MODEL_CHOICES: Record<'通义' | 'OpenRouter' | 'AIHubmix', Record<'LLM' | 'Embedding' | 'Rerank', Array<{ id: string; dimensions?: number }>>> = {
  通义: {
    LLM: [{ id: 'qwen-plus' }, { id: 'qwen-turbo' }, { id: 'qwen-max' }],
    Embedding: [{ id: 'text-embedding-v4', dimensions: 1024 }, { id: 'text-embedding-v3', dimensions: 1024 }],
    Rerank: [{ id: 'qwen3-rerank' }],
  },
  OpenRouter: {
    LLM: [{ id: 'openai/gpt-4.1-mini' }, { id: 'qwen/qwen3-235b-a22b' }],
    Embedding: [{ id: 'openai/text-embedding-3-small', dimensions: 1536 }, { id: 'openai/text-embedding-3-large', dimensions: 3072 }],
    Rerank: [{ id: 'cohere/rerank-v3.5' }],
  },
  AIHubmix: {
    LLM: [{ id: 'gpt-4.1-mini' }, { id: 'qwen-plus' }, { id: 'gpt-4.1' }],
    Embedding: [{ id: 'text-embedding-3-small', dimensions: 1536 }, { id: 'text-embedding-3-large', dimensions: 3072 }],
    Rerank: [{ id: 'jina-reranker-v3' }],
  },
};
type BundleKind = 'LLM' | 'Embedding' | 'Rerank';

function preset(provider: ConfigProvider, kind: ModelKind): Pick<ModelFormValues, 'model' | 'baseUrl' | 'dimensions'> {
  if (kind === 'OCR') return { model: 'DocMind 文档解析', baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com' };
  if (provider === 'OpenRouter') return {
    model: kind === 'LLM' ? 'qwen/qwen3-235b-a22b' : kind === 'Embedding' ? 'openai/text-embedding-3-small' : 'cohere/rerank-v3.5',
    baseUrl: 'https://openrouter.ai/api/v1', dimensions: kind === 'Embedding' ? 1536 : undefined,
  };
  if (provider === 'AIHubmix') return {
    model: kind === 'LLM' ? 'qwen-plus' : kind === 'Embedding' ? 'text-embedding-3-small' : 'jina-reranker-v3',
    baseUrl: 'https://aihubmix.com/v1', dimensions: kind === 'Embedding' ? 1536 : undefined,
  };
  return {
    model: kind === 'LLM' ? 'qwen-plus' : kind === 'Embedding' ? 'text-embedding-v4' : 'qwen3-rerank',
    baseUrl: kind === 'Rerank' ? 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks' : 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    dimensions: kind === 'Embedding' ? 1024 : undefined,
  };
}

function endpointHint(kind: ModelKind, provider: ConfigProvider) {
  if (kind === 'OCR') return '独立的 DocMind 异步服务；提交任务、查询状态、获取结果。';
  if (kind === 'Rerank') return `重排路径：${provider === '通义' ? '/reranks' : '/rerank'}；独立于对话接口。`;
  return `能力路径：${kind === 'LLM' ? '/chat/completions' : '/embeddings'}。`;
}

function DocMindDefaults() {
  const form = Form.useFormInstance();
  useEffect(() => {
    form.setFieldsValue({ name: '阿里云 DocMind · 文档解析', kind: 'OCR', provider: 'DocMind', model: '文档解析（大模型版）', baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com', enabled: true, isDefault: false });
  }, [form]);
  return null;
}

export default function ModelsPage() {
  const { state, setState, navigate } = useWorkspace();
  const [toast, contextHolder] = message.useMessage();
  const [form] = Form.useForm<ModelFormValues>();
  const [kindFilter, setKindFilter] = useState<ModelKind | 'all'>('all');
  const [providerFilter, setProviderFilter] = useState<ConfigProvider | 'all'>('all');
  const [bundle, setBundle] = useState<ModelConfig | null>(null);
  const [bundleKey, setBundleKey] = useState('');
  const [bundleModels, setBundleModels] = useState<Record<BundleKind, string>>({ LLM: '', Embedding: '', Rerank: '' });
  const [bundleDimensions, setBundleDimensions] = useState(1024);
  const [addProvider, setAddProvider] = useState<'通义' | 'OpenRouter' | 'AIHubmix'>('通义');
  const [addModels, setAddModels] = useState<Record<BundleKind, string>>({ LLM: 'qwen-plus', Embedding: 'text-embedding-v4', Rerank: 'qwen3-rerank' });
  const [addDimensions, setAddDimensions] = useState(1024);
  const [addDocMind, setAddDocMind] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [testing, setTesting] = useState<ModelConfig | null>(null);
  const [testingNow, setTestingNow] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [deleting, setDeleting] = useState<ModelConfig | null>(null);
  const [disabling, setDisabling] = useState<ModelConfig | null>(null);
  const [replacementId, setReplacementId] = useState<string | undefined>(undefined);
  const secretRef = useRef<InputRef>(null);
  const accessIdRef = useRef<InputRef>(null);
  const selectedKind = Form.useWatch('kind', form) || 'LLM';
  const selectedProvider = Form.useWatch('provider', form) || '通义';
  const selectedDimensions = Form.useWatch('dimensions', form);

  function clearSecrets() {
    if (secretRef.current?.input) secretRef.current.input.value = '';
    if (accessIdRef.current?.input) accessIdRef.current.input.value = '';
  }
  useEffect(() => {
    if (state.role !== 'admin') {
      clearSecrets();
      setFormOpen(false); setTesting(null); setDeleting(null); setDisabling(null); setTestingNow(false); setBundle(null); setBundleKey('');
      form.resetFields();
    }
  }, [state.role, form]);

  const models = state.models.filter(model =>
    (kindFilter === 'all' || model.kind === kindFilter)
    && (providerFilter === 'all' || model.provider === providerFilter)
    && `${model.name} ${model.model} ${model.provider}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const references = (model: ModelConfig) => state.knowledgeBases.filter(kb => kb.embeddingId === model.id || kb.rerankId === model.id);
  const isAdmin = () => state.role === 'admin';

  function closeForm() { clearSecrets(); setFormOpen(false); form.resetFields(); setEditing(null); setAddDocMind(false); }
  function fillAdd(provider: '通义' | 'OpenRouter' | 'AIHubmix') {
    const existing = state.models.filter(item => item.provider === provider && item.kind !== 'OCR');
    const choices = MODEL_CHOICES[provider];
    setAddProvider(provider);
    setAddModels({
      LLM: existing.find(item => item.kind === 'LLM')?.model || choices.LLM[0].id,
      Embedding: existing.find(item => item.kind === 'Embedding')?.model || choices.Embedding[0].id,
      Rerank: existing.find(item => item.kind === 'Rerank')?.model || choices.Rerank[0].id,
    });
    setAddDimensions(existing.find(item => item.kind === 'Embedding')?.dimensions || choices.Embedding[0].dimensions || 1024);
  }
  function openForm(model?: ModelConfig) {
    if (!isAdmin()) return;
    clearSecrets(); form.resetFields(); setEditing(model || null); setAddDocMind(false);
    if (!model) {
      fillAdd(providerFilter === 'OpenRouter' || providerFilter === 'AIHubmix' || providerFilter === '通义' ? providerFilter : '通义');
      setFormOpen(true);
      return;
    }
    const kind = model.kind;
    const provider: ConfigProvider = kind === 'OCR' ? 'DocMind' : model.provider;
    form.setFieldsValue({ ...model, provider, ...(!model.model ? preset(provider, kind) : {}) });
    setFormOpen(true);
  }
  function showDocMindForm() { setAddDocMind(true); }
  function changeKind(kind: ModelKind) {
    const current = form.getFieldValue('provider') as ConfigProvider;
    const provider: ConfigProvider = kind === 'OCR' ? 'DocMind' : current === 'DocMind' ? '通义' : current;
    clearSecrets(); form.setFieldsValue({ provider, ...preset(provider, kind) });
  }
  function changeProvider(provider: ConfigProvider) {
    const kind = form.getFieldValue('kind') as ModelKind;
    clearSecrets(); form.setFieldsValue(preset(provider, kind));
  }
  function openBundle(model: ModelConfig) {
    const sameProvider = state.models.filter(item => item.provider === model.provider && item.kind !== 'OCR');
    const embedding = sameProvider.find(item => item.kind === 'Embedding');
    setBundle(model);
    setBundleKey('');
    setBundleModels({
      LLM: sameProvider.find(item => item.kind === 'LLM')?.model || '',
      Embedding: embedding?.model || '',
      Rerank: sameProvider.find(item => item.kind === 'Rerank')?.model || '',
    });
    setBundleDimensions(embedding?.dimensions || 1024);
  }
  function chooseBundleModel(kind: BundleKind, modelId: string) {
    setBundleModels(previous => ({ ...previous, [kind]: modelId }));
    if (kind !== 'Embedding' || !bundle || bundle.provider === 'DocMind') return;
    const known = MODEL_CHOICES[bundle.provider].Embedding.find(item => item.id === modelId);
    if (known?.dimensions) setBundleDimensions(known.dimensions);
  }
  async function confirmBundle() {
    if (!isAdmin() || !bundle || bundle.provider === 'DocMind') return;
    if (['LLM', 'Embedding', 'Rerank'].some(kind => !bundleModels[kind as BundleKind].trim())) { toast.warning('请为对话、向量和重排分别选择或填写模型 ID。'); return; }
    try {
      setSharing(true);
      setState(await hub.shareKey({
        provider: bundle.provider,
        apiKey: bundleKey.trim(),
        models: (['LLM', 'Embedding', 'Rerank'] as BundleKind[]).map(kind => ({ kind, model: bundleModels[kind].trim(), ...(kind === 'Embedding' ? { dimensions: bundleDimensions } : {}) })),
      }));
      const provider = bundle.provider;
      setBundle(null); setBundleKey('');
      toast.success(`已选用${provider}。文本向量和检索重排已一起启用，请分别做连接测试。`);
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存失败'); }
    finally { setSharing(false); }
  }
  function chooseAddModel(kind: BundleKind, modelId: string) {
    setAddModels(previous => ({ ...previous, [kind]: modelId }));
    if (kind !== 'Embedding') return;
    const known = MODEL_CHOICES[addProvider].Embedding.find(item => item.id === modelId);
    if (known?.dimensions) setAddDimensions(known.dimensions);
  }
  async function saveModel() {
    if (!isAdmin()) return;
    if (!editing && !addDocMind) {
      if ((['LLM', 'Embedding', 'Rerank'] as BundleKind[]).some(kind => !addModels[kind].trim())) { toast.warning('请为对话、向量和重排分别选择或填写模型 ID。'); return; }
      const secret = secretRef.current?.input?.value.trim() || '';
      try {
        setSharing(true);
        setState(await hub.shareKey({
          provider: addProvider,
          apiKey: secret,
          models: (['LLM', 'Embedding', 'Rerank'] as BundleKind[]).map(kind => ({ kind, model: addModels[kind].trim(), ...(kind === 'Embedding' ? { dimensions: addDimensions } : {}) })),
        }));
        closeForm();
        toast.success(`已保存${addProvider}的对话、向量和重排。请分别做连接测试。`);
      } catch (error) { toast.error(error instanceof Error ? error.message : '保存失败'); }
      finally { setSharing(false); }
      return;
    }
    try {
      const values = await form.validateFields();
      if (!isAdmin()) return;
      if ((values.kind === 'OCR') !== (values.provider === 'DocMind')) { toast.error('DocMind 仅用于文档解析，OCR 需选择 DocMind。'); return; }
      if (values.isDefault && !values.enabled) { toast.warning('默认服务需要保持启用，请先启用或取消默认设置。'); return; }
      if (editing?.isDefault && (!values.isDefault || !values.enabled || values.kind !== editing.kind)) {
        toast.warning('请先为当前能力设置其他默认服务；停用默认服务时可在列表中选择替代服务。'); return;
      }
      if (editing && references(editing).length > 0) {
        const changed = values.model.trim() !== editing.model || values.provider !== editing.provider || values.kind !== editing.kind
          || values.baseUrl.trim() !== editing.baseUrl || values.dimensions !== editing.dimensions || !values.enabled;
        if (changed) { toast.warning('该配置被知识库引用。请先在知识库设置中更换绑定，再修改连接、模型、维度或停用。'); return; }
      }
      const secret = secretRef.current?.input?.value.trim() || '';
      const accessKeyId = accessIdRef.current?.input?.value.trim() || '';
      const payload = {
        name: values.name.trim(), provider: values.provider, kind: values.kind, model: values.model.trim(),
        baseUrl: values.baseUrl.trim(), enabled: values.enabled, isDefault: values.isDefault,
        ...(values.kind === 'Embedding' ? { dimensions: values.dimensions } : {}),
        ...(secret ? { apiKey: secret } : {}),
        ...(accessKeyId ? { accessKeyId } : {}),
      };
      setState(await hub.saveModel(payload, editing?.id));
      closeForm(); toast.success(editing ? '配置已保存。密钥只留在本机服务。' : '服务已添加。请运行连接测试后再用于构建或问答。');
    } catch (error) { if (error instanceof Error) toast.error(error.message); }
  }
  async function toggleModel(model: ModelConfig, enabled: boolean) {
    if (!isAdmin()) return;
    const bound = references(model);
    if (!enabled && bound.length) { toast.warning(`“${bound[0].name}”等知识库仍在使用此配置，请先更换绑定。`); return; }
    if (!enabled && model.isDefault) {
      setDisabling(model);
      setReplacementId(state.models.find(item => item.id !== model.id && item.kind === model.kind && item.enabled)?.id);
      return;
    }
    try { setState(await hub.toggleModel(model.id, enabled)); toast.success(enabled ? '模型已启用。' : '模型已停用。'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '更新失败'); }
  }
  async function disableDefault() {
    if (!isAdmin() || !disabling) return;
    if (references(disabling).length) { toast.warning('此配置已被知识库引用，请先更换绑定。'); setDisabling(null); return; }
    const alternatives = state.models.filter(model => model.id !== disabling.id && model.kind === disabling.kind && model.enabled);
    if (alternatives.length > 0 && !alternatives.some(model => model.id === replacementId)) { toast.warning('请选择一个可用的替代服务。'); return; }
    try {
      setState(await hub.toggleModel(disabling.id, false, replacementId));
      toast.success(alternatives.length ? '服务已停用，默认服务已切换。' : `服务已停用，${KIND_NAMES[disabling.kind]}当前没有可用服务。`);
      setDisabling(null); setReplacementId(undefined);
    } catch (error) { toast.error(error instanceof Error ? error.message : '停用失败'); }
  }
  async function makeDefault(model: ModelConfig) {
    if (!isAdmin()) return;
    if (!model.enabled) { toast.warning('请先启用此服务，再设置为默认。'); return; }
    try { setState(await hub.defaultModel(model.id)); toast.success(`已将“${model.name}”设为默认${KIND_NAMES[model.kind]}。`); }
    catch (error) { toast.error(error instanceof Error ? error.message : '设置失败'); }
  }
  function requestDelete(model: ModelConfig) {
    if (!isAdmin()) return;
    if (references(model).length) { toast.warning('该模型被知识库引用，需先更换知识库中的绑定。'); return; }
    if (model.isDefault) { toast.warning('请先为此能力设置其他默认服务，再删除当前默认配置。'); return; }
    setDeleting(model);
  }
  async function deleteModel() {
    if (!isAdmin() || !deleting) return;
    try { setState(await hub.deleteModel(deleting.id)); setDeleting(null); toast.success('配置已删除。'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '删除失败'); }
  }
  function openTest(model: ModelConfig) {
    if (!isAdmin()) return;
    if (!model.enabled) { toast.warning('请先启用服务，再测试连接。'); return; }
    setTesting(model); setTestResult(null);
  }
  function closeTest() { setTestingNow(false); setTesting(null); setTestResult(null); }
  async function runTest() {
    if (!isAdmin() || !testing || testingNow) return;
    setTestingNow(true); setTestResult(null);
    try {
      const { result, state: next } = await hub.testModel(testing.id);
      setState(next);
      setTestResult(result);
    } catch (error) { setTestResult({ ok: false, title: '测试失败', description: error instanceof Error ? error.message : '无法完成测试' }); }
    finally { setTestingNow(false); }
  }

  const columns: ColumnsType<ModelConfig> = [
    { title: '服务名称', dataIndex: 'name', key: 'name', width: 280, render: (_: string, model) => <div className="ops-model-name"><span className={`ops-provider-mark provider-${model.provider === '通义' ? 'qwen' : model.provider.toLowerCase()}`}>{PROVIDER_MARKS[model.provider]}</span><div><strong>{model.name}</strong><span>{model.model}</span>{model.kind === 'LLM' && model.provider !== 'DocMind' && <button type="button" className="ops-bring-along" onClick={() => openBundle(model)}>带上文本向量和检索重排</button>}</div></div> },
    { title: '供应商 / 能力', key: 'provider', width: 175, render: (_, model) => <div className="ops-model-meta"><span>{model.provider === 'DocMind' ? '阿里云 DocMind' : model.provider}</span><Tag bordered={false} className="ops-kind-tag">{model.kind === 'OCR' ? '文档解析 / OCR' : model.kind}</Tag></div> },
    { title: '连接状态', key: 'status', width: 134, render: (_, model) => <span className={`ops-state ${model.status === 'verified' ? 'success' : model.status === 'failed' ? 'danger' : 'neutral'}`}><i />{model.status === 'verified' ? '测试通过' : model.status === 'failed' ? '测试失败' : '尚未测试'}</span> },
    { title: '默认', key: 'default', width: 84, render: (_, model) => <Tooltip title={model.isDefault ? '当前能力的默认服务' : '设为该能力的默认服务'}><Button type="text" aria-label={`${model.isDefault ? '当前默认' : '设为默认'}：${model.name}`} className={model.isDefault ? 'ops-default-button active' : 'ops-default-button'} icon={model.isDefault ? <StarFilled /> : <StarOutlined />} onClick={() => makeDefault(model)} disabled={!model.enabled} /></Tooltip> },
    { title: '启用', key: 'enabled', width: 86, render: (_, model) => <Switch size="small" checked={model.enabled} onChange={checked => toggleModel(model, checked)} aria-label={`启用${model.name}`} /> },
    { title: '操作', key: 'actions', width: 202, fixed: 'right', render: (_, model) => <Space size={1}><Button type="link" size="small" icon={<ExperimentOutlined />} onClick={() => openTest(model)}>连接测试</Button><Tooltip title="编辑配置"><Button size="small" type="text" aria-label={`编辑${model.name}`} icon={<EditOutlined />} onClick={() => openForm(model)} /></Tooltip><Tooltip title="删除配置"><Button size="small" type="text" danger aria-label={`删除${model.name}`} icon={<DeleteOutlined />} onClick={() => requestDelete(model)} /></Tooltip></Space> },
  ];

  if (state.role !== 'admin') return <Result status="403" title="此页面仅向管理员开放" subTitle="请切换到管理员角色后再配置模型。" extra={<Button onClick={() => navigate('chat')}>返回在线问答</Button>} />;

  return <div className="models-page">
    {contextHolder}
    <div className="page-header"><div><div className="page-kicker">模型与连接</div><h1>模型服务</h1><p className="page-description">添加服务时一次填写对话、向量和重排，它们共用同一把 API Key。</p></div><Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => openForm()}>添加服务</Button></div>
    <div className="ops-demo-note"><InfoCircleOutlined /><span>密钥只保存在本机服务，界面不回显。请先测试连接，再用于构建和问答。</span><Tag bordered={false}>按测试结果调用</Tag></div>
    <div className="ops-capability-grid">{(['LLM', 'Embedding', 'Rerank', 'OCR'] as ModelKind[]).map(kind => <button key={kind} type="button" onClick={() => setKindFilter(kindFilter === kind ? 'all' : kind)} className={`surface ops-capability ${kindFilter === kind ? 'selected' : ''}`} aria-pressed={kindFilter === kind}><span className="ops-capability-label">{KIND_NAMES[kind]}<span className="ops-capability-count">{state.models.filter(model => model.kind === kind && model.enabled).length}<small>已启用</small></span></span><p>{KIND_DESCRIPTIONS[kind]}</p></button>)}</div>
    <section className="surface ops-config-surface">
      <Tabs activeKey={kindFilter} onChange={key => setKindFilter(key as ModelKind | 'all')} items={[{ key: 'all', label: `全部服务 ${state.models.length}` }, ...(['LLM', 'Embedding', 'Rerank', 'OCR'] as ModelKind[]).map(kind => ({ key: kind, label: KIND_NAMES[kind] }))]} />
      <div className="ops-filter-row"><Input value={search} onChange={event => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder="搜索服务名称、模型 ID" aria-label="搜索模型服务" className="ops-search" /><Select value={providerFilter} onChange={setProviderFilter} className="ops-provider-filter" aria-label="按供应商筛选" options={[{ value: 'all', label: '全部供应商' }, ...PROVIDERS.map(provider => ({ value: provider, label: provider === 'DocMind' ? '阿里云 DocMind' : provider }))]} /><span className="muted ops-result-count">共 {models.length} 项服务</span></div>
      <Table rowKey="id" columns={columns} dataSource={models} scroll={{ x: 950 }} pagination={models.length > 8 ? { pageSize: 8, showSizeChanger: false } : false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的服务"><Button onClick={() => { setSearch(''); setKindFilter('all'); setProviderFilter('all'); }}>清空筛选</Button></Empty> }} />
    </section>
    <div className="ops-help-row"><ApiOutlined /><span>知识库绑定向量模型和维度；修改前需解除引用并重建索引。文档解析使用独立服务凭证。</span></div>
    <Modal open={formOpen} title={editing ? '编辑模型服务' : addDocMind ? '添加文档解析' : '添加模型服务'} width={650} onCancel={closeForm} onOk={saveModel} okText={editing ? '保存配置' : addDocMind ? '添加服务' : '添加三项服务'} cancelText="取消" confirmLoading={sharing} destroyOnClose afterClose={clearSecrets}>
      {!editing && !addDocMind ? <><Alert type="info" showIcon message="一次添加对话、向量和重排" description="选择供应商后，三项模型都可以改。它们共用下面这一把 API Key。" className="ops-form-notice" /><div className="ops-bundle-fields"><label><span>供应商</span><Select aria-label="供应商" value={addProvider} onChange={fillAdd} options={['通义', 'OpenRouter', 'AIHubmix'].map(provider => ({ value: provider, label: provider }))} /></label>{(['LLM', 'Embedding', 'Rerank'] as BundleKind[]).map(kind => <label key={kind}><span>{KIND_NAMES[kind]}</span><AutoComplete aria-label={KIND_NAMES[kind]} value={addModels[kind]} options={MODEL_CHOICES[addProvider][kind].map(item => ({ value: item.id }))} onChange={value => chooseAddModel(kind, value)} placeholder="选择或填写模型 ID" /></label>)}<label><span>向量维度</span><InputNumber aria-label="向量维度" min={1} max={65536} precision={0} value={addDimensions} onChange={value => setAddDimensions(Number(value) || 0)} /></label><label><span>API Key</span><Input.Password ref={secretRef} autoComplete="new-password" placeholder="填写后加密保存在本机" aria-label="API Key" /></label></div><Button type="link" onClick={showDocMindForm}>只添加文档解析</Button></> : <><Alert type="info" showIcon message="密钥不会出现在页面状态里" description="填写后只提交到本机服务并加密保存。留空表示沿用已保存的凭证。" className="ops-form-notice" />
      <Form form={form} layout="vertical" requiredMark="optional" preserve={false}>{addDocMind && !editing ? <DocMindDefaults /> : null}
        <Form.Item name="name" label="服务名称" rules={[{ required: true, whitespace: true, message: '请填写便于识别的服务名称。' }, { max: 60, message: '名称最多 60 个字符。' }, { validator: (_, value: unknown) => typeof value === 'string' && state.models.some(model => model.id !== editing?.id && model.name.toLowerCase() === value.trim().toLowerCase()) ? Promise.reject(new Error('此服务名称已存在，请换一个名称。')) : Promise.resolve() }]}><Input maxLength={60} placeholder="例如：企业知识问答" /></Form.Item>
        <div className="ops-form-grid"><Form.Item name="kind" label="服务能力" rules={[{ required: true }]}><Select disabled={addDocMind} onChange={changeKind} options={(['LLM', 'Embedding', 'Rerank', 'OCR'] as ModelKind[]).map(kind => ({ value: kind, label: `${KIND_NAMES[kind]}${kind !== 'OCR' ? ` · ${kind}` : ''}` }))} /></Form.Item><Form.Item name="provider" label="供应商" rules={[{ required: true }]}><Select disabled={addDocMind} onChange={changeProvider} options={(selectedKind === 'OCR' || addDocMind ? ['DocMind'] : ['通义', 'OpenRouter', 'AIHubmix']).map(provider => ({ value: provider, label: provider === 'DocMind' ? '阿里云 DocMind' : provider }))} /></Form.Item></div>
        <Form.Item name="model" label={selectedKind === 'OCR' ? '解析服务标识' : '模型 ID'} rules={[{ required: true, whitespace: true, message: '请填写模型或服务标识。' }, { max: 160, message: '模型标识最多 160 个字符。' }, { validator: (_, value: unknown) => typeof value === 'string' && /[\r\n]/.test(value) ? Promise.reject(new Error('模型标识不能包含换行。')) : Promise.resolve() }]}><Input placeholder="填写供应商实际提供的模型 ID" /></Form.Item>
        <Form.Item name="baseUrl" label="服务基础地址" extra={<span>{endpointHint(selectedKind, selectedProvider)}{selectedProvider === '通义' ? ' 通义重排若使用业务空间地址，请改成实际 Workspace 域名。' : ''}</span>} rules={[{ required: true, whitespace: true, message: '请填写服务基础地址。' }, { validator: (_, value: unknown) => { if (typeof value !== 'string' || !value.trim()) return Promise.resolve(); try { const url = new URL(value.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return Promise.reject(new Error('请使用 HTTPS 地址，不要在地址中填写密钥、查询参数或片段。')); return Promise.resolve(); } catch { return Promise.reject(new Error('请填写完整有效的 HTTPS 地址。')); } } }]}><Input placeholder="https://…" /></Form.Item>
        {selectedKind === 'Embedding' ? <Form.Item name="dimensions" label="向量维度" extra={(selectedDimensions ?? 0) > 2000 ? '超过 2,000 维时需调整索引方案；原型不会静默截断向量。' : '构建后与知识库固定绑定，变更维度需重建索引。'} rules={[{ required: true, message: '请填写向量维度。' }, { type: 'integer', min: 1, max: 65536, message: '请填写 1–65,536 之间的整数。' }]}><InputNumber min={1} max={65536} precision={0} style={{ width: '100%' }} /></Form.Item> : null}
        {selectedKind === 'OCR' ? <Form.Item label="AccessKey ID"><Input ref={accessIdRef} autoComplete="off" placeholder="阿里云 AccessKey ID" /></Form.Item> : null}
        <Form.Item label={selectedKind === 'OCR' ? 'AccessKey Secret' : 'API Key'}><Input.Password ref={secretRef} autoComplete="new-password" placeholder={editing?.hasCredential ? "已保存，留空则不修改" : "填写后加密保存在本机"} /></Form.Item>
        <Space size={24}><Form.Item name="enabled" valuePropName="checked" noStyle><Checkbox>启用此服务</Checkbox></Form.Item><Form.Item name="isDefault" valuePropName="checked" noStyle><Checkbox>设为该能力默认服务</Checkbox></Form.Item></Space>
      </Form></>}
    </Modal>
    <Drawer open={!!testing} onClose={closeTest} title="连接测试" width={500} footer={<div className="ops-drawer-footer"><Button onClick={closeTest}>关闭</Button><Button type="primary" icon={<ExperimentOutlined />} loading={testingNow} onClick={runTest}>运行测试</Button></div>}>
      {testing ? <><Alert type="info" showIcon message="将向供应商发起一次真实请求" description="对话、向量和重排会消耗极少额度。DocMind 只校验凭证，不上传文件。" /><div className="ops-test-service"><span className="ops-provider-mark">{PROVIDER_MARKS[testing.provider]}</span><div><h3>{testing.name}</h3><p>{testing.provider} · {KIND_NAMES[testing.kind]}</p></div></div><div className="ops-connection-address">{testing.baseUrl}</div>{testResult ? <Alert className="ops-test-result" type={testResult.ok ? 'success' : 'error'} showIcon icon={testResult.ok ? <CheckCircleOutlined /> : undefined} message={testResult.title} description={testResult.description} /> : <p className="ops-test-hint">测试结果会更新连接状态。失败时请核对密钥、模型 ID 和地址。</p>}</> : null}
    </Drawer>
    <Modal open={!!bundle} title={bundle ? `选用${bundle.provider}` : '选用供应商'} onCancel={() => { setBundle(null); setBundleKey(''); }} onOk={() => void confirmBundle()} okText="启用这三项" cancelText="取消" confirmLoading={sharing}><p>共用这一把 Key。三项模型都可以改成账号里实际开通的 ID，也可以直接输入列表中没有的型号。</p><div className="ops-bundle-fields">{bundle && bundle.provider !== 'DocMind' && (['LLM', 'Embedding', 'Rerank'] as BundleKind[]).map(kind => <label key={kind}><span>{KIND_NAMES[kind]}</span><AutoComplete aria-label={KIND_NAMES[kind]} value={bundleModels[kind]} options={(bundle.provider === 'DocMind' ? [] : MODEL_CHOICES[bundle.provider][kind]).map(item => ({ value: item.id }))} onChange={value => chooseBundleModel(kind, value)} placeholder="选择或填写模型 ID" /></label>)}<label><span>向量维度</span><InputNumber aria-label="向量维度" min={1} max={65536} precision={0} value={bundleDimensions} onChange={value => setBundleDimensions(Number(value) || 0)} /></label></div><Input.Password aria-label="供应商 API Key" value={bundleKey} onChange={event => setBundleKey(event.target.value)} autoComplete="new-password" placeholder="粘贴一次 API Key" /></Modal>
    <Modal open={!!deleting} title="删除服务配置？" onCancel={() => setDeleting(null)} onOk={deleteModel} okText="删除配置" cancelText="保留" okButtonProps={{ danger: true }}><p>删除“{deleting?.name}”后，它会从本机配置中移除，不会删除供应商账号。</p></Modal>
    <Modal open={!!disabling} title="停用当前默认服务" onCancel={() => setDisabling(null)} onOk={disableDefault} okText="确认停用" cancelText="保持启用">
      <p>“{disabling?.name}”是当前{disabling ? KIND_NAMES[disabling.kind] : ''}的默认服务。</p>
      {disabling && state.models.some(model => model.id !== disabling.id && model.kind === disabling.kind && model.enabled) ? <Form layout="vertical"><Form.Item label="停用后使用此默认服务"><Select aria-label="选择替代默认服务" value={replacementId} onChange={setReplacementId} options={state.models.filter(model => model.id !== disabling.id && model.kind === disabling.kind && model.enabled).map(model => ({ value: model.id, label: `${model.name} · ${model.provider}` }))} /></Form.Item></Form> : <Alert type="warning" showIcon message="停用后，此能力没有可用服务" description={disabling?.kind === 'LLM' ? '在线问答将显示模型不可用，重新启用或添加对话模型后才能继续。' : '依赖该能力的操作将提示服务不可用，重新启用或添加服务后才能继续。'} />}
    </Modal>
  </div>;
}
