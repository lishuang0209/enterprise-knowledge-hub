import type { DocumentMetadata, Role, WorkspaceState } from './types';

let roleHeader: Role = 'admin';
export function setRoleHeader(role: Role) { roleHeader = role; }

export interface PreviewChunk { content: string; location: string }
export interface PreviewDocument { id?: string; name: string; status: string; error?: string | null; chunks: PreviewChunk[]; metadata?: DocumentMetadata; metadataStatus?: string }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Role', roleHeader);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let detail = '请求失败';
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch { /* The status line is enough when the body is not JSON. */ }
    throw new Error(detail);
  }
  return await response.json() as T;
}

export interface KnowledgeInput {
  name: string; description?: string; category?: string; tags?: string[];
  embeddingId?: string; rerankId?: string; chunkSize?: number; overlap?: number; chunkMode?: string; chunkSeparator?: string;
}

export interface ModelInput {
  name: string; provider: string; kind: string; model: string; baseUrl: string;
  enabled: boolean; isDefault: boolean; dimensions?: number; apiKey?: string; accessKeyId?: string;
}

export const hub = {
  state: () => request<WorkspaceState>('/api/state'),
  setRole: (role: Role) => request<WorkspaceState>('/api/role', { method: 'PUT', body: JSON.stringify({ role }) }),
  createKb: (body: KnowledgeInput) => request<WorkspaceState>('/api/knowledge-bases', { method: 'POST', body: JSON.stringify(body) }),
  updateKb: (id: string, body: KnowledgeInput) => request<WorkspaceState>(`/api/knowledge-bases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteKb: (id: string) => request<WorkspaceState>(`/api/knowledge-bases/${id}`, { method: 'DELETE' }),
  preview: (form: FormData) => request<{ documents: PreviewDocument[]; state: WorkspaceState }>('/api/documents/preview', { method: 'POST', body: form }),
  build: (ids: string[]) => request<WorkspaceState>('/api/documents/build', { method: 'POST', body: JSON.stringify({ ids }) }),
  retry: (id: string) => request<WorkspaceState>(`/api/documents/${id}/retry`, { method: 'POST' }),
  rechunk: (id: string, body: { chunkSize: number; overlap: number; chunkMode: string; chunkSeparator: string; save: boolean }) => request<{ chunks: PreviewChunk[]; state: WorkspaceState }>(`/api/documents/${id}/rechunk`, { method: 'POST', body: JSON.stringify(body) }),
  deleteDocs: (ids: string[]) => request<WorkspaceState>('/api/documents/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  editChunk: (id: string, position: number, content: string) => request<WorkspaceState>(`/api/documents/${id}/chunks/${position}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
  updateMetadata: (id: string, metadata: DocumentMetadata) => request<WorkspaceState>(`/api/documents/${id}/metadata`, { method: 'PATCH', body: JSON.stringify(metadata) }),
  extractMetadata: (id: string) => request<WorkspaceState>(`/api/documents/${id}/metadata/extract`, { method: 'POST' }),
  retrieve: (id: string, question: string, limit: number) => request<{ note: string; hits: Array<PreviewChunk & { id: string; docId: string; kbId: string; title: string; score: number; method: string; index: number; snapshotUpdatedAt?: string }> }>(`/api/knowledge-bases/${id}/retrieve`, { method: 'POST', body: JSON.stringify({ question, limit }) }),
  saveModel: (body: ModelInput, id?: string) => request<WorkspaceState>(id ? `/api/models/${id}` : '/api/models', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
  shareKey: (body: { provider: string; apiKey: string; models: Array<{ kind: string; model: string; dimensions?: number }> }) => request<WorkspaceState>('/api/models/share-key', { method: 'POST', body: JSON.stringify(body) }),
  toggleModel: (id: string, enabled: boolean, replacementId?: string) => request<WorkspaceState>(`/api/models/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled, replacementId }) }),
  defaultModel: (id: string) => request<WorkspaceState>(`/api/models/${id}/default`, { method: 'POST' }),
  deleteModel: (id: string) => request<WorkspaceState>(`/api/models/${id}`, { method: 'DELETE' }),
  testModel: (id: string) => request<{ result: { ok: boolean; title: string; description: string }; state: WorkspaceState }>(`/api/models/${id}/test`, { method: 'POST' }),
  patchConversation: (id: string, kbIds: string[]) => request<WorkspaceState>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ kbIds }) }),
  deleteConversation: (id: string) => request<WorkspaceState>(`/api/conversations/${id}`, { method: 'DELETE' }),
  reset: () => request<WorkspaceState>('/api/admin/reset', { method: 'POST' }),
  chat(body: { question: string; kbIds: string[]; conversationId?: string; replaceMessageId?: string }, signal: AbortSignal) {
    return fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': roleHeader }, body: JSON.stringify(body), signal });
  },
};
