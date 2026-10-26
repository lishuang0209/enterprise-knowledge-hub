export type Role = 'admin' | 'manager' | 'user';
export type Page = 'dashboard' | 'knowledge' | 'chat' | 'models' | 'logs' | 'settings';
export type DocStatus = 'ready' | 'failed' | 'queued' | 'indexing' | 'review';
export type Provider = '通义' | 'OpenRouter' | 'AIHubmix';
export type ModelKind = 'LLM' | 'Embedding' | 'Rerank' | 'OCR';
export type ChunkMode = 'length' | 'paragraph' | 'separator' | 'qa' | 'semantic';

export interface KnowledgeBase {
  id: string; name: string; description: string; color: string; category: string;
  tags: string[]; embeddingId: string; rerankId: string;
  chunkSize: number; overlap: number; chunkMode: ChunkMode; chunkSeparator: string; createdAt: string; updatedAt: string;
}
export interface Segment { index: number; content: string; location: string; revised?: boolean }
export interface DocumentMetadata {
  documentDate: string; version: string; subjects: string[]; owners: string[];
  keywords: string[]; questions: string[];
}
export interface KnowledgeDocument {
  id: string; kbId: string; name: string; type: string; size: string;
  pages: number; chunks: number; status: DocStatus; updatedAt: string;
  error?: string; content: string; sourceLabel: string;
  segments?: Segment[]; indexMode?: string;
  metadata: DocumentMetadata; metadataStatus: 'pending' | 'draft' | 'ready' | 'fallback' | 'edited' | 'failed';
  metadataModel?: string; metadataError?: string; metadataUpdatedAt?: string;
}
export interface ModelConfig {
  id: string; provider: Provider | 'DocMind'; kind: ModelKind; name: string;
  model: string; baseUrl: string; enabled: boolean; isDefault: boolean;
  dimensions?: number; status: 'verified' | 'untested' | 'failed';
  hasCredential?: boolean;
}
export interface Source {
  id: string; docId: string; kbId: string; title: string; location: string; content: string;
}
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; sources: Source[];
  status: 'complete' | 'streaming' | 'cancelled';
}
export interface Conversation {
  id: string; title: string; kbIds: string[]; messages: ChatMessage[]; updatedAt: string;
}
export interface QueryLog {
  id: string; at: string; question: string; kbIds: string[]; model: string;
  status: 'success' | 'failed' | 'cancelled' | 'degraded';
  inputTokens: number | null; outputTokens: number | null;
  duration: number; firstToken: number; stages: { label: string; ms: number }[];
  answer?: string; error?: string;
}
export interface WorkspaceState {
  schemaVersion: 1; role: Role; knowledgeBases: KnowledgeBase[];
  documents: KnowledgeDocument[]; models: ModelConfig[];
  conversations: Conversation[]; logs: QueryLog[];
}
