import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { hub, setRoleHeader } from './api';
import type { Page, Role, WorkspaceState } from './types';

interface WorkspaceContextValue {
  state: WorkspaceState; setState: Dispatch<SetStateAction<WorkspaceState>>;
  page: Page; navigate: (page: Page, kbId?: string) => void;
  selectedKbId: string | null; setSelectedKbId: (id: string | null) => void;
  importSignal: number; openImport: (kbId?: string) => void; consumeImport: () => void;
  offline: boolean; reload: () => Promise<void>; pauseSync: () => () => void;
  changeRole: (role: Role) => Promise<void>; resetWorkspace: () => Promise<void>;
}
const Context = createContext<WorkspaceContextValue | null>(null);
const pages: Page[] = ['dashboard', 'knowledge', 'chat', 'models', 'logs', 'settings'];
const emptyState: WorkspaceState = { schemaVersion: 1, role: 'admin', knowledgeBases: [], documents: [], models: [], conversations: [], logs: [] };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(emptyState);
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState<Page>(() => pages.find(item => item === location.hash.slice(1)) || 'dashboard');
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [importSignal, setImportSignal] = useState(0);
  const hold = useRef(0);
  const reload = useCallback(async () => {
    const next = await hub.state();
    setRoleHeader(next.role);
    setState(next);
    setOffline(false);
  }, []);
  useEffect(() => {
    let stopped = false;
    const tick = () => { if (stopped || hold.current) return; reload().catch(() => { if (!stopped) setOffline(true); }); };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [reload]);
  useEffect(() => { const onHash = () => setPage(pages.find(item => item === location.hash.slice(1)) || 'dashboard'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  function navigate(next: Page, kbId?: string) { if (kbId) setSelectedKbId(kbId); else if (next === 'knowledge') setSelectedKbId(null); setPage(next); location.hash = next; }
  function openImport(kbId?: string) { setSelectedKbId(kbId || null); setPage('knowledge'); location.hash = 'knowledge'; setImportSignal(count => count + 1); }
  function consumeImport() { setImportSignal(0); }
  function pauseSync() { hold.current += 1; return () => { hold.current = Math.max(0, hold.current - 1); }; }
  async function changeRole(role: Role) { setRoleHeader(role); setState(await hub.setRole(role)); setOffline(false); }
  async function resetWorkspace() { setState(await hub.reset()); setSelectedKbId(null); navigate('dashboard'); }
  return <Context.Provider value={{ state, setState, page, navigate, selectedKbId, setSelectedKbId, importSignal, openImport, consumeImport, offline, reload, pauseSync, changeRole, resetWorkspace }}>{children}</Context.Provider>;
}
export function useWorkspace() { const ctx = useContext(Context); if (!ctx) throw new Error('WorkspaceProvider is missing'); return ctx; }
export function uid(prefix = 'id') { return `${prefix}-${crypto.randomUUID()}`; }
export function formatDate(date: string) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(date)); }
export function formatTokens(value: number | null) { return value == null ? '未返回' : value.toLocaleString('zh-CN'); }
export function downloadCsv(filename: string, rows: unknown[][]) {
  const escape = (value: unknown) => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
