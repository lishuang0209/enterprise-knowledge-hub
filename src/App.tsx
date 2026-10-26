import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, App as AntApp, Avatar, Button, Empty, Modal, Select, Switch, Tag, Tooltip } from 'antd';
import { AppstoreOutlined, ArrowRightOutlined, BookOutlined, CheckCircleOutlined, CloudUploadOutlined, CommentOutlined, DatabaseOutlined, DeploymentUnitOutlined, FileTextOutlined, HistoryOutlined, InfoCircleOutlined, LineChartOutlined, MenuOutlined, PlusOutlined, RightOutlined, SafetyOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons';
import { formatDate, useWorkspace } from './workspace';
import type { Page, Role } from './types';

const KnowledgePage = lazy(() => import('./pages/KnowledgePage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const ModelsPage = lazy(() => import('./pages/ModelsPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));

const roleNames: Record<Role, string> = { admin: '管理员', manager: '知识库管理人员', user: '使用者' };
const navItems: { id: Page; label: string; icon: ReactNode; roles: Role[] }[] = [
  { id: 'dashboard', label: '工作台', icon: <AppstoreOutlined />, roles: ['admin', 'manager'] },
  { id: 'knowledge', label: '知识库', icon: <BookOutlined />, roles: ['admin', 'manager'] },
  { id: 'chat', label: '在线对话', icon: <CommentOutlined />, roles: ['admin', 'manager', 'user'] },
  { id: 'models', label: '模型服务', icon: <DeploymentUnitOutlined />, roles: ['admin'] },
  { id: 'logs', label: '日志监测', icon: <LineChartOutlined />, roles: ['admin'] },
  { id: 'settings', label: '工作区设置', icon: <SettingOutlined />, roles: ['admin'] },
];

export default function App() {
  const { state, page, navigate, changeRole, offline } = useWorkspace();
  const [mobileNav, setMobileNav] = useState(false);
  const allowed = navItems.filter(n => n.roles.includes(state.role));
  const active = allowed.find(n => n.id === page);
  useEffect(() => { if (!active) navigate(state.role === 'user' ? 'chat' : 'dashboard'); }, [active, navigate, state.role]);
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <button className="brand" onClick={() => navigate(state.role === 'user' ? 'chat' : 'dashboard')} aria-label="知序首页"><span className="brand-mark"><i /><i /><i /><i /></span><span><strong>知序</strong><small>企业知识中台</small></span></button>
      <div className="workspace-label"><span className="workspace-avatar">企</span><div><strong>企业内部工作区</strong><small>知识协作空间</small></div><span className="workspace-version">1.0</span></div>
      <div className="nav-caption">工作空间</div>
      <nav aria-label="主导航">{allowed.filter(n => n.id !== 'settings').map(n => <button key={n.id} onClick={() => { navigate(n.id); setMobileNav(false); }} className={`nav-item ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}>{n.icon}<span>{n.label}</span>{n.id === 'knowledge' ? <span className="nav-count">{state.knowledgeBases.length}</span> : null}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-status"><span />本地工作区<span className="local-badge">试用版</span></div>{state.role === 'admin' ? <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => { navigate('settings'); setMobileNav(false); }}><SettingOutlined /><span>工作区设置</span></button> : null}<div className="sidebar-footnote">让知识连接每一次协作</div></div>
    </aside>
    {mobileNav ? <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} /> : null}
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><Button className="mobile-menu" type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setMobileNav(true)} /><span>工作空间</span><RightOutlined /><strong>{active?.label || '工作台'}</strong></div><div className="topbar-right"><Tooltip title={offline ? '本地服务未连接。请先启动后端。' : '资料保存在本机。配置并测试模型后，才会调用云端向量、重排、对话或 DocMind。'}><span className="prototype-label"><span />{offline ? '服务未连接' : '本机服务'}</span></Tooltip><div className="topbar-divider" /><span className="role-caption">当前角色</span><Select aria-label="选择角色" className="role-select" value={state.role} onChange={changeRole} options={(Object.keys(roleNames) as Role[]).map(value => ({ value, label: roleNames[value] }))} /><Avatar size={30} className="user-avatar">{state.role === 'admin' ? '管' : state.role === 'manager' ? '知' : '用'}</Avatar></div></header>
      <main className={`page-content ${page === 'chat' ? 'chat-page-content' : ''}`}>{offline ? <Alert style={{ marginBottom: 16 }} type="warning" showIcon title="本地知识服务未连接" description="接口地址是 http://127.0.0.1:8000 。启动后端后刷新页面。" /> : null}<Suspense fallback={<PageLoading />}>{active ? page === 'dashboard' ? <Dashboard /> : page === 'knowledge' ? <KnowledgePage /> : page === 'chat' ? <ChatPage /> : page === 'models' ? <ModelsPage /> : page === 'logs' ? <LogsPage /> : <Settings /> : null}</Suspense></main>
    </div>
  </div>;
}

function PageLoading() {
  return <div className="surface page-loading" role="status" aria-live="polite"><span className="page-loading-dot" />正在打开页面…</div>;
}

function Dashboard() {
  const { state, navigate, openImport } = useWorkspace();
  const ready = state.documents.filter(d => d.status === 'ready');
  const failed = state.documents.filter(d => d.status === 'failed');
  const tokens = state.logs.reduce((total, log) => total + (log.inputTokens || 0) + (log.outputTokens || 0), 0);
  const metrics = [
    { label: '知识库', value: state.knowledgeBases.length, suffix: '个', icon: <BookOutlined />, note: '有序沉淀团队知识', className: 'blue' },
    { label: '已就绪资料', value: ready.length, suffix: '份', icon: <FileTextOutlined />, note: `${state.documents.length} 份资料 · ${failed.length} 份待处理`, className: 'violet' },
    { label: '有效知识片段', value: ready.reduce((n, d) => n + d.chunks, 0), suffix: '段', icon: <DatabaseOutlined />, note: '仅统计构建完成的内容', className: 'teal' },
    { label: '累计问答', value: state.logs.length, suffix: '次', icon: <CommentOutlined />, note: `已报告 ${(tokens / 1000).toFixed(1)}k Tokens`, className: 'orange' },
  ];
  const recent = [...state.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  return <div className="dashboard">
    <div className="page-header"><div><div className="page-kicker">WORKSPACE OVERVIEW</div><h1>工作台</h1><p className="page-description">把分散的资料，变成随时可用的团队知识。</p></div><div className="header-actions"><Button icon={<CommentOutlined />} onClick={() => navigate('chat')}>开始对话</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openImport()}>导入知识</Button></div></div>
    <div className="metric-grid">{metrics.map(item => <section className="metric" key={item.label}><div className="metric-top"><span>{item.label}</span><span className={`metric-icon ${item.className}`}>{item.icon}</span></div><div className="metric-number">{item.value.toLocaleString()}<small>{item.suffix}</small></div><p>{item.note}</p></section>)}</div>
    <section className="getting-started surface"><div className="start-intro"><div className="page-kicker">KNOWLEDGE TO ANSWERS</div><h2>从一份资料，开始知识沉淀</h2><p>导入、构建、验证，再把可靠的答案带给团队。</p><Button type="primary" icon={<CloudUploadOutlined />} onClick={() => openImport()}>导入第一批知识 <ArrowRightOutlined /></Button></div><div className="journey"><div className="journey-line" />{[{ n: '01', icon: <CloudUploadOutlined />, title: '导入资料', desc: 'Word / PDF / 图片 / 表格' }, { n: '02', icon: <DatabaseOutlined />, title: '构建知识', desc: '解析、分段与索引' }, { n: '03', icon: <CommentOutlined />, title: '在线问答', desc: '回答有据，来源可查' }].map(step => <div className="journey-step" key={step.n}><div className="journey-icon">{step.icon}<span>{step.n}</span></div><strong>{step.title}</strong><small>{step.desc}</small></div>)}</div></section>
    <div className="dashboard-columns"><section className="surface activity-panel"><div className="section-heading"><div><h2>问答使用趋势</h2><p>近 7 天问答次数</p></div>{state.role === 'admin' ? <Button type="text" onClick={() => navigate('logs')}>查看日志 <ArrowRightOutlined /></Button> : <Tag bordered={false}>当前浏览器</Tag>}</div><UsageChart logs={state.logs} /></section><section className="surface recent-panel"><div className="section-heading"><div><h2>最近导入</h2><p>关注资料构建进展</p></div><Button type="text" onClick={() => navigate('knowledge')}>全部 <ArrowRightOutlined /></Button></div><div className="recent-documents">{recent.length ? recent.map(doc => <button className="recent-document" key={doc.id} onClick={() => navigate('knowledge', doc.kbId)}><span className={`file-icon ${doc.type.toLowerCase()}`}><FileTextOutlined /></span><span className="recent-doc-text"><strong>{doc.name}</strong><small>{formatDate(doc.updatedAt)} · {doc.size}</small></span><span className={`status-pill ${doc.status === 'ready' ? 'success' : doc.status === 'failed' ? 'error' : 'pending'}`}>{doc.status === 'ready' ? '已就绪' : doc.status === 'failed' ? '失败' : '处理中'}</span></button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="导入资料后将在这里显示" />}</div></section></div>
    <section className="knowledge-overview"><div className="section-heading"><div><h2>我的知识库 <span className="title-count">{state.knowledgeBases.length}</span></h2><p>连接业务场景，构建共享知识</p></div><Button type="text" onClick={() => navigate('knowledge')}>管理知识库 <ArrowRightOutlined /></Button></div><div className="overview-kb-grid">{state.knowledgeBases.slice(0, 3).map(kb => { const docs = state.documents.filter(d => d.kbId === kb.id); return <button className="overview-kb surface" key={kb.id} onClick={() => navigate('knowledge', kb.id)}><div className="overview-kb-top"><span className={`kb-symbol ${kb.color}`}><BookOutlined /></span><Tag bordered={false}>{kb.category}</Tag></div><h3>{kb.name}</h3><p>{kb.description}</p><div className="overview-kb-foot"><span><FileTextOutlined /> {docs.length} 份资料</span><span><CheckCircleOutlined /> {docs.filter(d => d.status === 'ready').length} 份可用</span><ArrowRightOutlined /></div></button>; })}{!state.knowledgeBases.length ? <button className="new-kb-empty surface" onClick={() => navigate('knowledge')}><PlusOutlined /> 创建知识库</button> : null}</div></section>
    <footer className="page-footer"><SafetyOutlined /> 当前为内部试用空间，角色可自由切换<span>知序 1.0 · 本机验收</span></footer>
  </div>;
}

function UsageChart({ logs }: { logs: ReturnType<typeof useWorkspace>['state']['logs'] }) {
  const dates = Array.from({ length: 7 }, (_, i) => `2026-10-${20 + i}`);
  const counts = dates.map(date => logs.filter(log => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(log.at)) === date).length);
  const max = Math.max(4, ...counts);
  const [hover, setHover] = useState<number | null>(null);
  const points = counts.map((n, i) => ({ x: 48 + i * 72, y: 153 - (n / max) * 112 }));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  return <div className="usage-chart"><svg viewBox="0 0 520 200" role="img" aria-label={`10月20日至26日问答次数：${counts.join('、')}次`}><text x="12" y="15" className="chart-unit">次数</text>{[0, 1, 2, 3, 4].map(v => { const y = 153 - v / 4 * 112; return <g key={v}><line x1="48" x2="480" y1={y} y2={y} stroke="#edf0f6" strokeDasharray="4 5" /><text x="26" y={y + 4} textAnchor="middle">{Math.round(max * v / 4)}</text></g>; })}<path d={`${path} L480,153 L48,153 Z`} fill="#f1f5ff" /><path d={path} stroke="#315ff4" fill="none" strokeWidth="2.5" strokeLinejoin="round" />{points.map((p, i) => <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}><rect x={p.x - 25} y="25" width="50" height="135" fill="transparent" /><circle cx={p.x} cy={p.y} r={hover === i ? 5 : 3.5} fill="#fff" stroke="#315ff4" strokeWidth="2" /><text x={p.x} y="180" textAnchor="middle">10/{20 + i}</text>{hover === i ? <g><rect x={p.x - 28} y={p.y - 31} width="56" height="23" rx="5" fill="#25324b" /><text x={p.x} y={p.y - 15} textAnchor="middle" fill="#fff" style={{ fill: '#fff' }}>{counts[i]} 次</text></g> : null}</g>)}</svg><div className="chart-caption"><span /><span>问答次数</span><small>统计范围：2026/10/20–10/26</small></div></div>;
}

function Settings() {
  const { resetWorkspace } = useWorkspace();
  const { message } = AntApp.useApp();
  const [confirm, setConfirm] = useState(false);
  const [notes, setNotes] = useState(true);
  return <><div className="page-header"><div><div className="page-kicker">WORKSPACE SETTINGS</div><h1>工作区设置</h1><p className="page-description">管理本机试用空间与已导入的资料。</p></div><Tag color="blue">内部试用</Tag></div><section className="surface settings-section"><div className="section-heading"><h2><TeamOutlined /> 基本信息</h2></div><div className="settings-row"><span>工作区名称</span><strong>企业内部工作区</strong></div><div className="settings-row"><span>使用规模</span><strong>10 人 · 本机开发与验收</strong></div><div className="settings-row"><span>角色模式</span><strong>自由切换 · 暂无登录</strong></div><div className="settings-row"><span>数据范围</span><strong>本机数据库与文件目录</strong></div></section><section className="surface settings-section"><div className="section-heading"><h2><InfoCircleOutlined /> 使用说明</h2></div><Alert type="info" showIcon title="Markdown、Word、Excel 和有文字的 PDF 在本机解析" description="图片、扫描件和旧版 Word 会在 DocMind 配置通过后送去云端解析。未配置对话模型时，问答返回检索摘录，并在日志中标明。" /><div className="settings-row"><span>显示操作提示</span><Switch checked={notes} onChange={setNotes} /></div>{notes ? <p className="muted">建议依次体验：导入资料 → 分段预览 → 确认构建 → 检索测试 → 在线对话 → 查看日志。</p> : null}</section><section className="surface settings-section"><div className="section-heading"><h2><HistoryOutlined /> 数据管理</h2></div><div className="settings-row"><div><strong>清空本机工作区</strong><p className="muted">删除已导入的资料、会话和日志，模型配置恢复为未测试的预设。</p></div><Button danger onClick={() => setConfirm(true)}>清空工作区</Button></div></section><Modal open={confirm} title="清空本机工作区？" okText="确认清空" cancelText="保留当前数据" okButtonProps={{ danger: true }} onCancel={() => setConfirm(false)} onOk={() => { void resetWorkspace().then(() => { setConfirm(false); message.success('已清空本机工作区'); }); }}><p>此操作会删除本机保存的知识库、原文件、会话和日志，不能从页面恢复。</p></Modal></>;
}
