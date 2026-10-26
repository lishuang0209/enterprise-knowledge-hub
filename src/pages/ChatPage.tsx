import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Drawer, Empty, Input, Modal, Select, Tag, Tooltip, message,
} from 'antd';
import {
  ArrowRightOutlined, BookOutlined, CheckOutlined, CopyOutlined,
  CustomerServiceOutlined, DeleteOutlined, FileTextOutlined, HistoryOutlined,
  InfoCircleOutlined, MessageOutlined, PlusOutlined, ReloadOutlined,
  SafetyCertificateOutlined, ScheduleOutlined, SearchOutlined, SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { hub } from '../api';
import type { ChatMessage, Source } from '../types';
import { formatDate, useWorkspace } from '../workspace';
import './chat.css';

type SnapshotSource = Source & { snapshotUpdatedAt?: string };

const suggestions = [
  { title: '差旅报销标准', question: '出差住宿和交通报销有哪些标准？', icon: <FileTextOutlined />, className: 'travel' },
  { title: '年假如何申请', question: '员工年假有多少天，应该如何申请？', icon: <ScheduleOutlined />, className: 'leave' },
  { title: '了解产品权限', question: '产品中的管理员、编辑者与访客有哪些权限？', icon: <SafetyCertificateOutlined />, className: 'permission' },
  { title: '客户服务流程', question: '客户咨询和问题反馈应该如何处理？', icon: <CustomerServiceOutlined />, className: 'service' },
];


export default function ChatPage() {
  const { state, setState, navigate, pauseSync, reload } = useWorkspace();
  const [messageApi, messageContext] = message.useMessage();
  const readyKbIds = state.knowledgeBases.filter(kb => state.documents.some(doc => doc.kbId === kb.id && doc.status === 'ready')).map(kb => kb.id);
  const [activeId, setActiveId] = useState<string | null>(() => state.conversations[0]?.id || null);
  const [draftKbIds, setDraftKbIds] = useState<string[]>(() => readyKbIds);
  const [question, setQuestion] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SnapshotSource | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const activeModel = state.models.find(model => model.kind === 'LLM' && model.enabled && model.status === 'verified' && model.isDefault)
    || state.models.find(model => model.kind === 'LLM' && model.enabled && model.status === 'verified');
  const modelUnavailable = false;
  const activeConversation = state.conversations.find(item => item.id === activeId);
  const selectedKbIds = (activeConversation?.kbIds || draftKbIds).filter(id => state.knowledgeBases.some(kb => kb.id === id));
  const selectedDocuments = state.documents.filter(doc => selectedKbIds.includes(doc.kbId));
  const readyDocuments = selectedDocuments.filter(doc => doc.status === 'ready');
  const pendingCount = selectedDocuments.filter(doc => doc.status !== 'ready').length;
  const messages = activeConversation?.messages || [];
  const conversations = [...state.conversations]
    .filter(item => item.title.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const currentSourceDocument = source ? state.documents.find(doc => doc.id === source.docId && doc.kbId === source.kbId) : undefined;
  const currentSourceKb = source ? state.knowledgeBases.find(kb => kb.id === source.kbId) : undefined;
  const isSourceDeleted = !!source && (!currentSourceDocument || !currentSourceKb);
  const isSourceUpdated = !!source && !!currentSourceDocument && !!source.snapshotUpdatedAt && source.snapshotUpdatedAt !== currentSourceDocument.updatedAt;

  function finishRun(_status?: 'success' | 'cancelled') { abortRef.current?.abort(); }

  useEffect(() => () => {
    abortRef.current?.abort();
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    if (!autoScrollRef.current || !scrollRef.current) return;
    const frame = requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  async function updateKbSelection(ids: string[]) {
    if (abortRef.current) return;
    const available = ids.filter(id => readyKbIds.includes(id));
    setDraftKbIds(available);
    if (!activeConversation) return;
    setState(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === activeConversation.id ? { ...item, kbIds: available } : item) }));
    try { setState(await hub.patchConversation(activeConversation.id, available)); } catch { /* The next refresh restores the saved selection. */ }
  }

  function startNewConversation() {
    if (abortRef.current) return;
    setActiveId(null); setQuestion(''); setDraftKbIds(readyKbIds); autoScrollRef.current = true;
  }

  async function startQuestion(value: string, retryMessageId?: string) {
    const text = value.trim();
    if (abortRef.current || !text) return;
    if (text.length > 2000) { void messageApi.warning('请将问题控制在 2,000 字以内。'); return; }
    const kbIds = selectedKbIds.filter(id => state.knowledgeBases.some(kb => kb.id === id));
    const available = state.documents.filter(doc => kbIds.includes(doc.kbId) && doc.status === 'ready');
    if (!kbIds.length || !available.length) { void messageApi.warning('请先选择至少一个已有就绪资料的知识库。'); return; }
    const release = pauseSync();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true); setQuestion(''); autoScrollRef.current = true;
    const conversationId = activeConversation?.id;
    let serverConversation = conversationId || '';
    let serverMessage = retryMessageId || '';
    try {
      const response = await hub.chat({ question: text, kbIds, conversationId, replaceMessageId: retryMessageId }, controller.signal);
      if (!response.ok || !response.body) throw new Error((await response.text()) || '提问失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const event = /event: (\w+)/.exec(part)?.[1];
          const dataLine = part.split('\n').find(line => line.startsWith('data: '));
          if (!event || !dataLine) continue;
          const data = JSON.parse(dataLine.slice(6)) as { conversationId?: string; messageId?: string; text?: string; sources?: SnapshotSource[]; message?: ChatMessage };
          if (event === 'meta' && data.conversationId && data.messageId) {
            serverConversation = data.conversationId;
            serverMessage = data.messageId;
            setActiveId(serverConversation);
            setState(previous => {
              const existing = previous.conversations.find(item => item.id === serverConversation);
              const assistant: ChatMessage = { id: serverMessage, role: 'assistant', content: '', sources: data.sources || [], status: 'streaming' };
              const userMessage: ChatMessage = { id: `user-${serverMessage}`, role: 'user', content: text, sources: [], status: 'complete' };
              if (!existing) {
                return { ...previous, conversations: [{ id: serverConversation, title: text.length > 20 ? `${text.slice(0, 20)}…` : text, kbIds, messages: retryMessageId ? [assistant] : [userMessage, assistant], updatedAt: new Date().toISOString() }, ...previous.conversations] };
              }
              return { ...previous, conversations: previous.conversations.map(item => item.id === serverConversation ? { ...item, kbIds, updatedAt: new Date().toISOString(), messages: retryMessageId ? item.messages.map(message => message.id === retryMessageId ? assistant : message) : [...item.messages, userMessage, assistant] } : item) };
            });
          }
          if (event === 'token' && data.text) {
            const token = data.text;
            setState(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === serverConversation ? { ...item, messages: item.messages.map(message => message.id === serverMessage ? { ...message, content: message.content + token } : message) } : item) }));
          }
        }
      }
      await reload();
    } catch (error) {
      if (!controller.signal.aborted) void messageApi.error(error instanceof Error ? error.message : '提问失败');
      try { await reload(); } catch { /* The offline banner covers a stopped service. */ }
    } finally {
      abortRef.current = null;
      setIsGenerating(false);
      release();
    }
  }

  function retryAnswer(answerId: string) {
    if (abortRef.current) return;
    const answerIndex = messages.findIndex(item => item.id === answerId);
    const priorQuestion = messages.slice(0, answerIndex).reverse().find(item => item.role === 'user');
    if (priorQuestion) void startQuestion(priorQuestion.content, answerId);
  }

  async function copyAnswer(item: ChatMessage) {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(item.content);
      setCopiedId(item.id);
      if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 1800);
    } catch { void messageApi.info('浏览器未开放剪贴板，请选中回答文字复制。'); }
  }

  function deleteConversation(id: string) {
    if (abortRef.current) return;
    Modal.confirm({
      title: '删除这段对话？', content: '会话会从本机删除，运行日志仍会保留。',
      okText: '删除对话', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => {
        setState(await hub.deleteConversation(id));
        if (activeId === id) startNewConversation();
      },
    });
  }

  const noReadyKb = !readyKbIds.length;
  const canSubmit = !isGenerating && !modelUnavailable && !!question.trim() && readyDocuments.length > 0 && question.length <= 2000;

  return (
    <div className="chat-page">
      {messageContext}
      <div className="page-header chat-page-header">
        <div><div className="page-kicker">KNOWLEDGE CHAT</div><h1>在线对话</h1><p className="muted">让每个问题，都有清晰的知识来源。</p></div>
        <div className="chat-demo-label"><span />本机知识问答</div>
      </div>

      <section className="chat-workspace" aria-label="知识库对话工作区">
        <aside className="chat-history">
          <div className="chat-history-top">
            <Button type="primary" icon={<PlusOutlined />} block onClick={startNewConversation} disabled={isGenerating}>发起新对话</Button>
            <Input prefix={<SearchOutlined />} placeholder="搜索会话" allowClear value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索会话" />
          </div>
          <div className="chat-history-label"><span>最近对话</span><span>{state.conversations.length}</span></div>
          <div className="chat-session-list">
            {conversations.length === 0 ? <div className="chat-history-empty"><HistoryOutlined /><p>{search ? '没有匹配的会话' : '从一个问题开始'}</p><span>{search ? '试试其他关键词' : '对话保存在本机服务'}</span></div>
              : conversations.map(item => (
                <div className={`chat-session-row ${item.id === activeId ? 'is-active' : ''}`} key={item.id}>
                  <button type="button" className="chat-session-select" disabled={isGenerating} onClick={() => { setActiveId(item.id); setQuestion(''); autoScrollRef.current = true; }}>
                    <MessageOutlined /><span className="chat-session-copy"><strong>{item.title}</strong><span>{formatDate(item.updatedAt)} · {item.messages.filter(msg => msg.role === 'user').length} 个问题</span></span>
                  </button>
                  <Tooltip title="删除会话"><Button size="small" type="text" className="chat-session-delete" aria-label={`删除会话 ${item.title}`} disabled={isGenerating} icon={<DeleteOutlined />} onClick={() => deleteConversation(item.id)} /></Tooltip>
                </div>
              ))}
          </div>
          <div className="chat-history-footer"><InfoCircleOutlined /><span>无登录试用<br /><span>会话保存在本机</span></span></div>
        </aside>

        <div className="chat-main">
          <div className="chat-toolbar">
            <div className="chat-toolbar-title"><span className="chat-brand-symbol"><BookOutlined /></span><div><strong>知序 · 知识助手</strong><span>在企业知识中，找到可靠答案</span></div></div>
            <Tooltip title={activeModel ? "已使用通过测试的对话模型。" : "未配置对话模型时，回答是检索摘录，不是模型生成。"}><span className="chat-model-badge"><span />{activeModel?.model || '检索摘录'}</span></Tooltip>
          </div>
          <div className="chat-kb-bar">
            <span className="chat-kb-label"><BookOutlined />知识范围</span>
            <Select mode="multiple" value={selectedKbIds} onChange={updateKbSelection} disabled={isGenerating || noReadyKb} placeholder={noReadyKb ? '暂无可用知识库' : '选择用于回答的知识库'} maxTagCount="responsive" className="chat-kb-select" aria-label="选择对话知识库" optionFilterProp="label" options={state.knowledgeBases.map(kb => {
              const count = state.documents.filter(doc => doc.kbId === kb.id && doc.status === 'ready').length;
              return { value: kb.id, label: `${kb.name}${count ? '' : '（无就绪资料）'}`, disabled: count === 0 };
            })} />
            <Tooltip title="仅检索所选知识库中的已就绪资料，历史回答仍保留当时的引用。"><InfoCircleOutlined className="chat-kb-info" /></Tooltip>
          </div>
          {pendingCount > 0 && <div className="chat-inline-alert"><Alert type="warning" showIcon message={`所选知识库中有 ${pendingCount} 份资料尚未就绪，本次仅检索已就绪资料。`} /></div>}
          {!activeModel && <div className="chat-inline-alert"><Alert type="info" showIcon message="尚未配置通过测试的对话模型。现在可以提问，回答会是检索摘录。" action={state.role === 'admin' ? <Button size="small" type="text" onClick={() => navigate('models')}>配置模型<ArrowRightOutlined /></Button> : undefined} /></div>}

          <div ref={scrollRef} className="chat-messages" onScroll={() => {
            const element = scrollRef.current;
            if (element) autoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
          }}>
            {messages.length === 0 ? (
              <div className="chat-welcome">
                <div className="chat-welcome-icon"><BookOutlined /></div>
                <span className="chat-welcome-eyebrow">你的企业知识，随问随用</span>
                <h2>你好，今天想了解什么？</h2>
                <p>从制度规范到产品说明，在选中的知识库里寻找答案。<br />每条回答都带来源，方便核对与追溯。</p>
                {noReadyKb ? <div className="chat-empty-knowledge"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可用于回答的知识资料" />{state.role !== 'user' && <Button onClick={() => navigate('knowledge')}>前往知识库，导入第一份资料<ArrowRightOutlined /></Button>}<span>资料构建完成后，即可在这里发起对话。</span></div>
                  : <div className="chat-suggestions">{suggestions.map(item => <button className="chat-suggestion" type="button" key={item.title} disabled={isGenerating || modelUnavailable || !readyDocuments.length} onClick={() => startQuestion(item.question)}><span className={`chat-suggestion-icon ${item.className}`}>{item.icon}</span><span><strong>{item.title}</strong><span>{item.question}</span></span><ArrowRightOutlined /></button>)}</div>}
                {!noReadyKb && <div className="chat-welcome-note"><InfoCircleOutlined />没有找到依据时会直接说明，不会用模型常识编造制度。</div>}
              </div>
            ) : <div className="chat-message-list">{messages.map((item, index) => <article key={item.id} className={`chat-message chat-message-${item.role}`}>
              <div className={`chat-avatar ${item.role === 'assistant' ? 'assistant' : 'user'}`}>{item.role === 'assistant' ? <BookOutlined /> : '我'}</div>
              <div className="chat-message-body">
                <div className="chat-message-author">{item.role === 'assistant' ? '知序知识助手' : '你'}{item.role === 'assistant' && <span>{activeModel ? '模型回答' : '检索摘录'}</span>}</div>
                <div className={`chat-message-text ${item.status === 'streaming' ? 'is-streaming' : ''}`}>
                  {item.content || (item.status === 'streaming' ? <span className="chat-thinking"><span /><span /><span />正在检索知识库</span> : '生成已停止，尚未输出回答。')}
                </div>
                {item.status === 'cancelled' && <div className="chat-cancelled"><StopOutlined />已停止生成 · 最终 Tokens 未获取</div>}
                {item.role === 'assistant' && item.status !== 'streaming' && item.sources.length > 0 && <div className="chat-citations"><div className="chat-citations-label"><FileTextOutlined />参考来源 <span>{item.sources.length}</span></div><div className="chat-citation-items">{item.sources.map((citation, citationIndex) => {
                  const deleted = !state.knowledgeBases.some(kb => kb.id === citation.kbId) || !state.documents.some(doc => doc.id === citation.docId && doc.kbId === citation.kbId);
                  return <button type="button" className={`chat-citation ${deleted ? 'is-deleted' : ''}`} key={citation.id} onClick={() => setSource(citation)} title={`${citation.title} · ${citation.location}`}><span>{citationIndex + 1}</span><FileTextOutlined /><span>{citation.title}</span>{deleted && <small>已删除</small>}<ArrowRightOutlined /></button>;
                })}</div></div>}
                {item.role === 'assistant' && item.status !== 'streaming' && <div className="chat-message-actions"><Tooltip title={copiedId === item.id ? '已复制' : '复制回答'}><Button type="text" size="small" aria-label="复制回答" icon={copiedId === item.id ? <CheckOutlined /> : <CopyOutlined />} disabled={!item.content} onClick={() => void copyAnswer(item)}>{copiedId === item.id ? '已复制' : '复制'}</Button></Tooltip>{index === messages.length - 1 && <Button type="text" size="small" icon={<ReloadOutlined />} disabled={isGenerating || modelUnavailable || !readyDocuments.length} onClick={() => retryAnswer(item.id)}>重新回答</Button>}<span>请结合来源核对内容</span></div>}
              </div>
            </article>)}</div>}
          </div>

          <div className="chat-composer-area">
            {!selectedKbIds.length && !noReadyKb && <div className="chat-selection-hint"><InfoCircleOutlined />请选择至少一个知识库后提问。</div>}
            <div className={`chat-composer ${!readyDocuments.length || modelUnavailable ? 'is-disabled' : ''}`}>
              <Input.TextArea value={question} onChange={event => setQuestion(event.target.value)} placeholder={modelUnavailable ? '请先启用可用的对话模型' : readyDocuments.length ? '输入你的问题，答案将从所选知识库中寻找…' : '请先选择已有就绪资料的知识库'} autoSize={{ minRows: 2, maxRows: 5 }} disabled={isGenerating || modelUnavailable || !readyDocuments.length} maxLength={2000} aria-label="输入知识库问题" onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSubmit) startQuestion(question); }
              }} />
              <div className="chat-composer-bottom"><span>{isGenerating ? <><span className="chat-live-dot" />正在生成回答</> : <><span>Enter 发送</span><span className="chat-composer-separator">·</span><span>Shift + Enter 换行</span></>}</span><div>{question.length > 1500 && <span className="chat-input-count">{question.length}/2000</span>}{isGenerating ? <Button icon={<StopOutlined />} onClick={() => finishRun('cancelled')}>停止生成</Button> : <Button type="primary" icon={<SendOutlined />} disabled={!canSubmit} onClick={() => startQuestion(question)}>发送</Button>}</div></div>
            </div>
            <div className="chat-prototype-note"><InfoCircleOutlined />回答只依据所选知识库。未配置模型时返回检索摘录；用量以供应商返回为准，未返回不会记为 0。</div>
          </div>
        </div>
      </section>

      <Drawer open={!!source} onClose={() => setSource(null)} width={520} title={<span className="chat-drawer-title"><FileTextOutlined />答案来源</span>} className="chat-source-drawer">
        {source && <>
          <div className="chat-source-heading"><span className="chat-source-file-icon"><FileTextOutlined /></span><div><h3>{source.title}</h3><span>{currentSourceKb?.name || '已删除的知识库'}</span></div></div>
          <div className="chat-source-meta"><span>来源位置</span><strong>{source.location}</strong></div>
          <div className="chat-source-meta"><span>引用状态</span><Tag color={isSourceDeleted ? 'orange' : isSourceUpdated ? 'gold' : 'blue'}>{isSourceDeleted ? '资料已删除 · 历史快照' : isSourceUpdated ? '资料已更新 · 历史快照' : '回答时的片段快照'}</Tag></div>
          {(isSourceDeleted || isSourceUpdated) && <Alert showIcon type="warning" message={isSourceDeleted ? '来源资料已被删除' : '来源资料已有更新'} description={isSourceDeleted ? '保留本次回答产生时的引用快照以便追溯。新的问答不会再检索这份已删除资料。' : '以下为回答时保留的内容，不代表知识库的最新版本。'} />}
          <div className="chat-source-section-label">引用内容<small>回答时的片段</small></div>
          <div className="chat-source-excerpt">{source.content || '该条历史引用未保存片段内容。'}</div>
          <div className="chat-source-footnote"><InfoCircleOutlined />来源位置来自解析结果：页码、标题或表格行。</div>
          {state.role !== 'user' && currentSourceKb && <Button block className="chat-source-open" onClick={() => { setSource(null); navigate('knowledge', currentSourceKb.id); }}>查看知识库<ArrowRightOutlined /></Button>}
        </>}
      </Drawer>
    </div>
  );
}
