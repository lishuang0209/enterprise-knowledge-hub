import { useEffect, useState } from 'react';
import { Alert, Button, DatePicker, Descriptions, Drawer, Empty, Input, Result, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowDownOutlined, CheckCircleOutlined, ClockCircleOutlined, DownloadOutlined, FileTextOutlined, InfoCircleOutlined, SearchOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { QueryLog } from '../types';
import { downloadCsv, formatDate, formatTokens, useWorkspace } from '../workspace';
import './operations.css';

const STATUS: Record<QueryLog['status'], { label: string; className: string }> = {
  success: { label: '已完成', className: 'success' },
  degraded: { label: '降级完成', className: 'warning' },
  failed: { label: '失败', className: 'danger' },
  cancelled: { label: '已停止', className: 'neutral' },
};
function seconds(ms: number) { return `${(ms / 1000).toFixed(2)} 秒`; }
function totalTokens(log: QueryLog) { return log.inputTokens == null && log.outputTokens == null ? null : (log.inputTokens ?? 0) + (log.outputTokens ?? 0); }

export default function LogsPage() {
  const { state, navigate } = useWorkspace();
  const [toast, contextHolder] = message.useMessage();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<QueryLog['status'] | 'all'>('all');
  const [kbId, setKbId] = useState('all');
  const [model, setModel] = useState('all');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [selected, setSelected] = useState<QueryLog | null>(null);
  useEffect(() => { if (state.role !== 'admin') setSelected(null); }, [state.role]);

  const filtered = state.logs.filter(log => {
    const time = new Date(log.at).getTime();
    return (status === 'all' || log.status === status)
      && (kbId === 'all' || log.kbIds.includes(kbId))
      && (model === 'all' || log.model === model)
      && log.question.toLowerCase().includes(search.trim().toLowerCase())
      && (!range?.[0] || time >= range[0].startOf('day').valueOf())
      && (!range?.[1] || time <= range[1].endOf('day').valueOf());
  }).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const kbNames = (ids: string[]) => ids.map(id => state.knowledgeBases.find(kb => kb.id === id)?.name || '已删除知识库');
  const knownUsage = filtered.some(log => log.inputTokens !== null || log.outputTokens !== null);
  const reportedTokens = filtered.reduce((sum, log) => sum + (log.inputTokens ?? 0) + (log.outputTokens ?? 0), 0);
  const missingUsage = filtered.filter(log => log.inputTokens == null || log.outputTokens == null).length;
  const cancelled = filtered.filter(log => log.status === 'cancelled').length;
  const completed = filtered.filter(log => log.status === 'success' || log.status === 'degraded').length;
  const attempted = filtered.length - cancelled;
  const failureCount = filtered.filter(log => log.status === 'failed').length;
  const average = filtered.length ? filtered.reduce((sum, log) => sum + log.duration, 0) / filtered.length : null;
  const completionRate = attempted ? `${((completed / attempted) * 100).toFixed(1)}%` : '—';
  const maxStage = selected ? Math.max(...selected.stages.map(stage => stage.ms), 1) : 1;
  const modelOptions = [...new Set(state.logs.map(log => log.model).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const hasFilters = !!search || status !== 'all' || kbId !== 'all' || model !== 'all' || !!range;

  function clearFilters() { setSearch(''); setStatus('all'); setKbId('all'); setModel('all'); setRange(null); }
  function exportLogs() {
    if (state.role !== 'admin') return;
    if (!filtered.length) { toast.info('当前筛选下没有可导出的日志。'); return; }
    const fullDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai', hour12: false });
    downloadCsv(`知识库问答日志-${dayjs().format('YYYY-MM-DD')}.csv`, [
      ['日志 ID', '时间（北京时间）', '提问内容', '知识库', '模型', '状态', '输入 Tokens', '输出 Tokens', '已报告 Tokens', '总耗时（ms）', '首字耗时（ms）', '分阶段耗时', '回答', '错误原因', '数据类型'],
      ...filtered.map(log => [log.id, fullDate.format(new Date(log.at)), log.question, kbNames(log.kbIds).join(' / '), log.model, STATUS[log.status].label, formatTokens(log.inputTokens), formatTokens(log.outputTokens), formatTokens(totalTokens(log)), log.duration, log.firstToken > 0 ? log.firstToken : '未返回', log.stages.map(stage => `${stage.label}: ${stage.ms} ms`).join(' / '), log.answer || '', log.error || '', '本机运行日志']),
    ]);
    toast.success(`已导出当前筛选的 ${filtered.length} 条日志。`);
  }

  const columns: ColumnsType<QueryLog> = [
    { title: '时间', dataIndex: 'at', key: 'at', width: 118, render: (at: string) => <span className="ops-log-date">{formatDate(at)}</span> },
    { title: '提问内容', dataIndex: 'question', key: 'question', width: 300, render: (question: string, log) => <button type="button" className="ops-question-button" onClick={() => setSelected(log)}><strong>{question}</strong><span>{kbNames(log.kbIds).join(' · ') || '未选择知识库'}</span></button> },
    { title: '对话模型', dataIndex: 'model', key: 'model', width: 163, render: (model: string) => <span className="ops-log-model">{model}</span> },
    { title: '状态', dataIndex: 'status', key: 'status', width: 116, render: (value: QueryLog['status']) => <span className={`ops-state ${STATUS[value].className}`}><i />{STATUS[value].label}</span> },
    { title: '已报告 Tokens', key: 'tokens', width: 145, render: (_, log) => <Tooltip title={log.inputTokens == null || log.outputTokens == null ? '用量未完整返回，不将缺失值记作 0。' : `输入 ${formatTokens(log.inputTokens)} / 输出 ${formatTokens(log.outputTokens)}`}><span className="ops-token-value">{formatTokens(totalTokens(log))}{(log.inputTokens == null || log.outputTokens == null) && totalTokens(log) !== null ? <small>部分</small> : null}</span></Tooltip> },
    { title: '总耗时', dataIndex: 'duration', key: 'duration', width: 110, render: (ms: number) => <span className="ops-numeric">{seconds(ms)}</span> },
    { title: '操作', key: 'actions', width: 74, fixed: 'right', render: (_, log) => <Button type="link" size="small" onClick={() => setSelected(log)}>详情</Button> },
  ];

  if (state.role !== 'admin') return <Result status="403" title="此页面仅向管理员开放" subTitle="日志包含问答内容与运行信息。可返回在线问答，或切换到管理员查看。" extra={<Button onClick={() => navigate('chat')}>返回在线问答</Button>} />;

  return <div className="logs-page">
    {contextHolder}
    <div className="page-header"><div><div className="page-kicker">运行与洞察</div><h1>日志监测</h1><p className="page-description">从一次提问追踪回答、消耗和耗时，让问题有迹可循。</p></div><Button size="large" icon={<DownloadOutlined />} onClick={exportLogs} disabled={!filtered.length}>导出当前结果</Button></div>
    <div className="ops-demo-note"><InfoCircleOutlined /><span>用量以供应商返回为准。未返回不会记成 0，停止生成的用量记为未返回。</span><Tag bordered={false}>匿名会话</Tag></div>
    <div className="ops-stats-grid">
      <div className="surface ops-stat"><span className="ops-stat-label"><FileTextOutlined />问答请求</span><strong>{filtered.length.toLocaleString('zh-CN')}<small>次</small></strong><span className="ops-stat-foot">已停止 {cancelled} 次 · 失败 {failureCount} 次</span></div>
      <div className="surface ops-stat"><span className="ops-stat-label"><ArrowDownOutlined />已报告 Tokens</span><strong>{knownUsage ? reportedTokens.toLocaleString('zh-CN') : '未返回'}</strong><span className="ops-stat-foot">{missingUsage ? `${missingUsage} 条记录缺少完整用量` : '已记录输入与输出用量'}</span></div>
      <div className="surface ops-stat"><span className="ops-stat-label"><ClockCircleOutlined />平均总耗时</span><strong>{average === null ? '—' : (average / 1000).toFixed(2)}{average !== null ? <small>秒</small> : null}</strong><span className="ops-stat-foot">当前筛选范围内的全部请求</span></div>
      <div className="surface ops-stat"><span className="ops-stat-label"><CheckCircleOutlined />回答完成率</span><strong>{completionRate}</strong><span className="ops-stat-foot">含降级完成，主动停止不计失败</span></div>
    </div>
    <section className="surface ops-logs-surface"><div className="ops-section-header"><div><h2 className="section-heading">问答记录</h2><span className="muted">查看每次对话的完整运行情况</span></div><span className="ops-results-label">{filtered.length} 条记录</span></div>
      <div className="ops-log-filters"><Input className="ops-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索提问内容" aria-label="搜索提问内容" allowClear prefix={<SearchOutlined />} /><Select value={status} onChange={setStatus} aria-label="按回答状态筛选" className="ops-status-filter" options={[{ label: '全部状态', value: 'all' }, ...Object.entries(STATUS).map(([value, info]) => ({ value, label: info.label }))]} /><Select value={kbId} onChange={setKbId} aria-label="按知识库筛选" className="ops-kb-filter" options={[{ value: 'all', label: '全部知识库' }, ...state.knowledgeBases.map(kb => ({ value: kb.id, label: kb.name }))]} /><Select value={model} onChange={setModel} aria-label="按对话模型筛选" className="ops-kb-filter" options={[{ value: 'all', label: '全部模型' }, ...modelOptions.map(value => ({ value, label: value }))]} /><DatePicker.RangePicker value={range} onChange={dates => setRange(dates)} placeholder={['开始日期', '结束日期']} aria-label="选择日志日期范围" className="ops-date-filter" format="YYYY-MM-DD" />{hasFilters ? <Button type="text" onClick={clearFilters}>重置</Button> : null}</div>
      <Table rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1080 }} pagination={filtered.length > 8 ? { pageSize: 8, showSizeChanger: false, showTotal: total => `共 ${total} 条` } : false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilters ? '没有符合条件的问答记录' : '暂无问答记录，开始一次对话即可查看运行情况'}>{hasFilters ? <Button onClick={clearFilters}>清空筛选</Button> : <Button type="primary" onClick={() => navigate('chat')}>开始在线问答</Button>}</Empty> }} />
      <div className="ops-table-footnote"><InfoCircleOutlined /><span>用量缺失显示“未返回”；停止生成可能已产生消耗，不能视为 0。日志按匿名浏览器会话记录。</span></div>
    </section>
    <Drawer title="问答运行详情" width={660} open={!!selected} onClose={() => setSelected(null)} footer={<div className="ops-drawer-footer"><span className="muted">本机运行记录</span><Button onClick={() => setSelected(null)}>关闭详情</Button></div>}>
      {selected ? <div className="ops-log-detail"><div className="ops-detail-heading"><span className={`ops-state ${STATUS[selected.status].className}`}><i />{STATUS[selected.status].label}</span><span className="muted">{formatDate(selected.at)}</span></div>{selected.status === 'cancelled' ? <Alert type="info" showIcon message="用户已停止生成" description="本次请求不计为失败；停止前产生的消耗以已返回用量为准，缺失部分仍为未知。" /> : selected.status === 'degraded' ? <Alert type="warning" showIcon message="回答已完成，部分步骤发生降级" description={selected.error || '重排暂不可用，已使用原召回顺序继续回答。'} /> : selected.status === 'failed' ? <Alert type="error" showIcon message="本次回答未完成" description={selected.error || '服务未正常返回，请检查模型连接或稍后重试。'} /> : null}
        <section className="ops-detail-section"><h3>提问内容</h3><div className="ops-question-box">{selected.question}</div><Space size={[4, 6]} wrap className="ops-detail-kbs">{kbNames(selected.kbIds).map((name, index) => <Tag key={`${selected.kbIds[index]}-${index}`} bordered={false}>{name}</Tag>)}</Space></section>
        <section className="ops-detail-section"><h3>回答内容</h3>{selected.answer ? <div className="ops-answer-box">{selected.answer}</div> : <div className="ops-missing-answer">{selected.status === 'cancelled' ? '停止前未产生可保存的回答。' : '本条记录没有返回回答内容。'}</div>}</section>
        <section className="ops-detail-section"><h3>模型与消耗</h3><Descriptions column={2} size="small" bordered items={[{ key: 'model', label: '对话模型', children: selected.model, span: 2 }, { key: 'in', label: '输入 Tokens', children: formatTokens(selected.inputTokens) }, { key: 'out', label: '输出 Tokens', children: formatTokens(selected.outputTokens) }, { key: 'duration', label: '总耗时', children: seconds(selected.duration) }, { key: 'first', label: '首字耗时', children: selected.firstToken > 0 ? seconds(selected.firstToken) : '未返回' }]} />{selected.inputTokens == null || selected.outputTokens == null ? <p className="ops-usage-note">用量未完整返回；已报告的数值不代表完整消耗。</p> : <p className="ops-usage-note">以上为供应商返回的用量。</p>}</section>
        <section className="ops-detail-section"><h3>分阶段耗时</h3>{selected.stages.length ? <div className="ops-stage-list">{selected.stages.map((stage, index) => <div className="ops-stage" key={`${stage.label}-${index}`}><span>{stage.label}</span><div className="ops-stage-track"><i style={{ width: `${Math.max(2, (stage.ms / maxStage) * 100)}%` }} /></div><strong>{stage.ms.toLocaleString('zh-CN')} ms</strong></div>)}</div> : <p className="muted">本条记录未返回分阶段耗时。</p>}<p className="ops-usage-note">每个阶段使用独立时间口径，可能包含并行或重试，不以简单相加代替总耗时。</p></section>
        <div className="ops-record-id">记录 ID：{selected.id}</div>
      </div> : null}
    </Drawer>
  </div>;
}
