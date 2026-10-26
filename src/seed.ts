import type { KnowledgeDocument, WorkspaceState } from './types';

export function createSeed(): WorkspaceState {
  return {
    schemaVersion: 1,
    role: 'admin',
    knowledgeBases: [
      { id: 'kb-hr', name: '人事行政知识库', description: '员工手册、假勤制度与差旅报销，让日常办事更简单。', color: 'blue', category: '制度规范', tags: ['人事', '行政', '内部制度'], embeddingId: 'embed-tongyi', rerankId: 'rerank-tongyi', chunkSize: 600, overlap: 80, chunkMode: 'length', chunkSeparator: '', createdAt: '2026-10-20T09:00:00+08:00', updatedAt: '2026-10-26T09:30:00+08:00' },
      { id: 'kb-product', name: '产品与研发知识库', description: '产品使用指南、权限说明及研发规范，快速找到技术答案。', color: 'violet', category: '产品文档', tags: ['产品', '研发', '使用指南'], embeddingId: 'embed-tongyi', rerankId: 'rerank-tongyi', chunkSize: 800, overlap: 100, chunkMode: 'paragraph', chunkSeparator: '', createdAt: '2026-10-21T09:00:00+08:00', updatedAt: '2026-10-25T16:20:00+08:00' },
      { id: 'kb-service', name: '客户服务知识库', description: '服务标准、常见问题与处理流程，让每一次响应都有依据。', color: 'teal', category: '业务知识', tags: ['客服', 'FAQ', '服务规范'], embeddingId: 'embed-tongyi', rerankId: 'rerank-tongyi', chunkSize: 600, overlap: 80, chunkMode: 'length', chunkSeparator: '', createdAt: '2026-10-22T09:00:00+08:00', updatedAt: '2026-10-26T08:50:00+08:00' },
    ],
    documents: ([
      { id: 'doc-travel', kbId: 'kb-hr', name: '差旅与费用报销管理办法.docx', type: 'DOCX', size: '1.2 MB', pages: 6, chunks: 24, status: 'ready', updatedAt: '2026-10-26T09:30:00+08:00', sourceLabel: '第三章 · 差旅报销流程', content: '【演示制度】差旅与费用报销管理办法\n\n一、出差前审批\n员工应在出差前提交出差申请，填写事由、行程和预算，经直属负责人审批后出行。\n\n二、报销时限与材料\n出差结束后 30 个自然日内提交报销申请。需提供已审批的出差申请、交通票据、住宿发票与费用明细；票据抬头应与公司信息一致。\n\n三、住宿标准\n一线城市住宿上限 500 元/人/晚，其他城市 350 元/人/晚。超出预算应提前获得部门负责人批准。\n\n四、报销流程\n员工提交申请 → 直属负责人确认 → 财务审核 → 出纳付款。资料不完整时退回补充，不直接作废申请。' },
      { id: 'doc-handbook', kbId: 'kb-hr', name: '员工手册（2026版）.pdf', type: 'PDF', size: '3.6 MB', pages: 18, chunks: 63, status: 'ready', updatedAt: '2026-10-25T14:10:00+08:00', sourceLabel: '第 8 页 · 假勤管理', content: '【演示手册】员工手册（2026版）\n\n假勤管理\n年假请提前 3 个工作日在假勤系统提交，选择假期类型、起止日期并说明工作交接安排。审批人为直属负责人。假期额度以假勤系统展示为准。\n紧急请假应先告知负责人，返岗后 2 个工作日内补办手续。\n\n办公与信息安全\n离开工位时锁定电脑，内部资料不得上传至未经公司认可的第三方平台。\n入职办理：提交入职资料、人事核验、领取办公设备、开通工作账号。' },
      { id: 'doc-leave', kbId: 'kb-hr', name: '假期申请常见问题.md', type: 'MD', size: '18 KB', pages: 1, chunks: 12, status: 'ready', updatedAt: '2026-10-24T10:00:00+08:00', sourceLabel: '年假申请 · 第 4–12 行', content: '【演示 FAQ】\n# 年假申请\n年假需提前 3 个工作日提交申请，经直属负责人审批后生效。请同步交接待办事项。年假余额在假勤系统“我的假期”中查看。\n# 申请撤回\n尚未开始的假期可申请撤回；已开始的假期请联系人事处理。\n# 审批进度\n在“我的申请”查看进度，待审批超过 2 个工作日可提醒负责人。' },
      { id: 'doc-scan', kbId: 'kb-hr', name: '办公设备领用登记.png', type: 'PNG', size: '2.4 MB', pages: 1, chunks: 0, status: 'failed', error: '演示异常：图片文字模糊，无法识别表格。可重试模拟处理。', updatedAt: '2026-10-26T09:10:00+08:00', sourceLabel: '图片 · 登记表', content: '【演示解析内容】办公设备领用需填写设备名称、资产编号、领用人、所属部门与领用日期，经行政核验后完成登记。' },
      { id: 'doc-product', kbId: 'kb-product', name: '产品使用指南.pdf', type: 'PDF', size: '5.8 MB', pages: 32, chunks: 96, status: 'ready', updatedAt: '2026-10-25T16:20:00+08:00', sourceLabel: '第 12 页 · 成员与权限', content: '【演示产品文档】\n产品包含工作空间、项目、成员管理和资源设置。\n管理员可邀请成员、配置工作空间及管理全部项目。编辑者可创建和修改项目内容；查看者可阅读已共享的内容，不能修改设置。\n邀请成员：在工作空间设置中选择“成员管理”，点击“邀请成员”，填写邮箱并指定角色。\n修改权限后在下一次访问时生效；如需调整账号角色，请联系工作空间管理员。' },
      { id: 'doc-permissions', kbId: 'kb-product', name: '角色权限说明.xlsx', type: 'XLSX', size: '86 KB', pages: 1, chunks: 18, status: 'ready', updatedAt: '2026-10-23T11:30:00+08:00', sourceLabel: '工作表「角色权限」· 第 2–5 行', content: '【演示表格】工作表：角色权限\n行 1：角色 | 查看内容 | 编辑内容 | 邀请成员 | 管理设置\n行 2：管理员 | 是 | 是 | 是 | 是\n行 3：编辑者 | 是 | 是 | 否 | 否\n行 4：查看者 | 是 | 否 | 否 | 否\n行 5：访客 | 仅共享内容 | 否 | 否 | 否\n所有权限调整需由管理员发起，编辑者不能邀请成员。' },
      { id: 'doc-service', kbId: 'kb-service', name: '客户服务标准与响应流程.md', type: 'MD', size: '42 KB', pages: 1, chunks: 28, status: 'ready', updatedAt: '2026-10-26T08:50:00+08:00', sourceLabel: '响应标准 · 第 6–18 行', content: '【演示服务规范】\n工作日服务时间为 09:00–18:00。一般客户咨询在 2 小时内首次响应；影响核心功能的紧急问题在 30 分钟内响应并升级技术支持。\n处理流程：登记工单 → 判断问题等级 → 分配负责人 → 跟踪解决 → 向客户确认并关闭。\n无法当场解决的问题应告知预计反馈时间，每个工作日至少更新一次处理进展。\n退款相关问题需核对订单与合同条款，交由业务负责人确认，不可自行承诺。' },
      { id: 'doc-faq', kbId: 'kb-service', name: '常见问题与处理指引.csv', type: 'CSV', size: '65 KB', pages: 1, chunks: 35, status: 'ready', updatedAt: '2026-10-24T16:30:00+08:00', sourceLabel: '第 2–6 行', content: '【演示表格】\n行 1：问题类型 | 处理方式 | 负责团队\n行 2：忘记密码 | 引导用户通过绑定邮箱重置密码 | 客户支持\n行 3：功能不可用 | 收集截图、发生时间与操作步骤，建立技术工单 | 技术支持\n行 4：发票申请 | 核对订单、发票抬头与税号后转财务 | 财务\n行 5：权限不足 | 联系工作空间管理员核验角色 | 客户支持\n行 6：服务投诉 | 登记诉求，升级客户成功负责人 | 客户成功' },
    ] as Array<Omit<KnowledgeDocument, 'metadata' | 'metadataStatus'>>).map(doc => ({
      ...doc,
      metadata: { documentDate: '', version: '', subjects: [], owners: [], keywords: [], questions: [] },
      metadataStatus: 'pending' as const,
    })),
    models: [
      { id: 'llm-tongyi', provider: '通义', kind: 'LLM', name: '通义 · 对话模型', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true, isDefault: true, status: 'verified' },
      { id: 'embed-tongyi', provider: '通义', kind: 'Embedding', name: '通义 · 文本向量', model: 'text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enabled: true, isDefault: true, dimensions: 1024, status: 'verified' },
      { id: 'rerank-tongyi', provider: '通义', kind: 'Rerank', name: '通义 · 检索重排', model: 'qwen3-rerank', baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks', enabled: true, isDefault: true, status: 'verified' },
      { id: 'llm-openrouter', provider: 'OpenRouter', kind: 'LLM', name: 'OpenRouter · 对话模型', model: 'openai/gpt-4.1-mini', baseUrl: 'https://openrouter.ai/api/v1', enabled: false, isDefault: false, status: 'untested' },
      { id: 'embed-openrouter', provider: 'OpenRouter', kind: 'Embedding', name: 'OpenRouter · 文本向量', model: 'openai/text-embedding-3-small', baseUrl: 'https://openrouter.ai/api/v1', enabled: false, isDefault: false, dimensions: 1536, status: 'untested' },
      { id: 'rerank-openrouter', provider: 'OpenRouter', kind: 'Rerank', name: 'OpenRouter · 检索重排', model: 'cohere/rerank-v3.5', baseUrl: 'https://openrouter.ai/api/v1/rerank', enabled: false, isDefault: false, status: 'untested' },
      { id: 'llm-aihubmix', provider: 'AIHubmix', kind: 'LLM', name: 'AIHubmix · 对话模型', model: 'gpt-4.1-mini', baseUrl: 'https://aihubmix.com/v1', enabled: false, isDefault: false, status: 'untested' },
      { id: 'embed-aihubmix', provider: 'AIHubmix', kind: 'Embedding', name: 'AIHubmix · 文本向量', model: 'text-embedding-3-small', baseUrl: 'https://aihubmix.com/v1', enabled: false, isDefault: false, dimensions: 1536, status: 'untested' },
      { id: 'rerank-aihubmix', provider: 'AIHubmix', kind: 'Rerank', name: 'AIHubmix · 检索重排', model: 'jina-reranker-v3', baseUrl: 'https://aihubmix.com/v1/rerank', enabled: false, isDefault: false, status: 'untested' },
      { id: 'ocr-docmind', provider: 'DocMind', kind: 'OCR', name: '阿里云 DocMind · 文档解析', model: '文档解析（大模型版）', baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com', enabled: true, isDefault: true, status: 'verified' },
    ],
    conversations: [],
    logs: [
      { id: 'log-1', at: '2026-10-26T09:40:00+08:00', question: '出差结束后多久内需要提交报销？', kbIds: ['kb-hr'], model: 'qwen-plus', status: 'success', inputTokens: 1248, outputTokens: 186, duration: 2160, firstToken: 410, stages: [{ label: '问题处理', ms: 120 }, { label: '混合检索', ms: 180 }, { label: '重排', ms: 260 }, { label: '回答生成', ms: 1600 }], answer: '根据演示差旅制度，应在出差结束后 30 个自然日内提交，并附出差申请、票据和费用明细。' },
      { id: 'log-2', at: '2026-10-26T09:22:00+08:00', question: '编辑者可以邀请其他成员吗？', kbIds: ['kb-product'], model: 'qwen-plus', status: 'success', inputTokens: 1086, outputTokens: 148, duration: 1840, firstToken: 380, stages: [{ label: '混合检索', ms: 190 }, { label: '重排', ms: 220 }, { label: '回答生成', ms: 1430 }], answer: '演示权限表规定编辑者可以编辑内容，但不能邀请成员。邀请操作由管理员完成。' },
      { id: 'log-3', at: '2026-10-25T15:30:00+08:00', question: '客户紧急问题的响应时限是多少？', kbIds: ['kb-service'], model: 'qwen-plus', status: 'degraded', inputTokens: 930, outputTokens: 135, duration: 3120, firstToken: 520, stages: [{ label: '混合检索', ms: 210 }, { label: '重排超时', ms: 900 }, { label: '回答生成', ms: 2010 }], answer: '影响核心功能的紧急问题在 30 分钟内响应并升级技术支持。', error: '演示：重排超时，已采用混合召回排序。' },
      { id: 'log-4', at: '2026-10-24T11:10:00+08:00', question: '年假如何申请？', kbIds: ['kb-hr'], model: 'qwen-plus', status: 'success', inputTokens: 1160, outputTokens: 208, duration: 2400, firstToken: 460, stages: [{ label: '混合检索', ms: 180 }, { label: '重排', ms: 240 }, { label: '回答生成', ms: 1980 }], answer: '提前 3 个工作日在假勤系统提交，并说明交接安排，由直属负责人审批。' },
      { id: 'log-5', at: '2026-10-23T16:00:00+08:00', question: '如何处理功能异常？', kbIds: ['kb-service'], model: 'qwen-plus', status: 'failed', inputTokens: null, outputTokens: null, duration: 1020, firstToken: 0, stages: [{ label: '混合检索', ms: 200 }, { label: '模型请求', ms: 820 }], error: '演示：模型服务暂时不可用，请稍后重试。' },
      { id: 'log-6', at: '2026-10-22T10:20:00+08:00', question: '查看者能修改设置吗？', kbIds: ['kb-product'], model: 'qwen-plus', status: 'success', inputTokens: 850, outputTokens: 112, duration: 1620, firstToken: 340, stages: [{ label: '混合检索', ms: 170 }, { label: '重排', ms: 200 }, { label: '回答生成', ms: 1250 }], answer: '查看者只能阅读共享内容，不能修改设置。' },
      { id: 'log-7', at: '2026-10-21T14:45:00+08:00', question: '帮我整理员工手册', kbIds: ['kb-hr'], model: 'qwen-plus', status: 'cancelled', inputTokens: null, outputTokens: null, duration: 860, firstToken: 310, stages: [{ label: '检索与重排', ms: 360 }, { label: '生成至停止', ms: 500 }], answer: '员工手册包含假勤管理与办公规范……' },
      { id: 'log-8', at: '2026-10-20T09:30:00+08:00', question: '报销需要哪些材料？', kbIds: ['kb-hr'], model: 'qwen-plus', status: 'success', inputTokens: 1020, outputTokens: 165, duration: 1980, firstToken: 400, stages: [{ label: '混合检索', ms: 180 }, { label: '重排', ms: 220 }, { label: '回答生成', ms: 1580 }], answer: '出差申请、交通票据、住宿发票与费用明细。' },
    ],
  };
}
