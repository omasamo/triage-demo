import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutDashboard, ListOrdered, Inbox as InboxIcon, Users, MessageSquareText, ScrollText, Settings as SettingsIcon,
  Search, Mail, PanelLeft, Sparkles, X, ArrowRight, ShieldAlert, Moon, Sun, RotateCcw,
} from 'lucide-react';
import type { Snapshot } from '../core/engine.ts';
import type { AiStatus } from '../core/api.ts';
import type { Band, PriorityChange, ProcessedEmail, Weights } from '../core/types.ts';
import type { ChatAnswer, ChatTurn } from '../core/chat.ts';
import { createApi, isDesktop, type ClientApi } from './api.ts';
import { BandChip, SourceBadge, fmtTime } from './components/ui.tsx';
import { ItemDrawer } from './components/ItemDrawer.tsx';
import { Overview } from './pages/Overview.tsx';
import { Queue } from './pages/Queue.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Workload } from './pages/Workload.tsx';
import { Assistant } from './pages/Assistant.tsx';
import { Audit } from './pages/Audit.tsx';
import { Settings } from './pages/Settings.tsx';

export type Route = 'overview' | 'queue' | 'inbox' | 'workload' | 'assistant' | 'audit' | 'settings';

interface Toast { id: number; kind: 'change' | 'danger' | 'ok' | 'info'; title: string; body?: string; itemId?: string; band?: Band }

interface Ctx {
  s: Snapshot;
  ai: AiStatus | null;
  api: ClientApi;
  go: (r: Route, opts?: { emailId?: string; filter?: Record<string, string> }) => void;
  open: (itemId: string) => void;
  next: () => Promise<void>;
  busy: boolean;
  setWeights: (w: Partial<Weights>) => Promise<void>;
  handoff: (itemId: string, toId: string) => Promise<void>;
  override: (itemId: string, band: Band | null, reason: string) => Promise<void>;
  chat: (q: string, history: ChatTurn[]) => Promise<ChatAnswer>;
  flash: Set<string>;
  routeOpts: { emailId?: string; filter?: Record<string, string> };
  chatLog: [ChatTurn & { answer?: ChatAnswer }][number][];
  setChatLog: (f: (l: Ctx['chatLog']) => Ctx['chatLog']) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  refreshAi: () => Promise<void>;
}
const AppCtx = createContext<Ctx>(null!);
export const useApp = () => useContext(AppCtx);

const NAV: { id: Route; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'queue', label: 'Priority queue', icon: ListOrdered },
  { id: 'inbox', label: 'Email signals', icon: InboxIcon },
  { id: 'workload', label: 'Workload', icon: Users },
  { id: 'assistant', label: 'Assistant', icon: MessageSquareText },
];

export function App() {
  const [api, setApi] = useState<ClientApi | null>(null);
  const [s, setS] = useState<Snapshot | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [route, setRoute] = useState<Route>('overview');
  const [routeOpts, setRouteOpts] = useState<Ctx['routeOpts']>({});
  const [itemId, setItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  // The sidebar folds to icons on narrow windows (and unfolds again when the window grows); the toggle still works.
  const narrow = '(max-width: 1100px)';
  const [collapsed, setCollapsed] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(narrow).matches);
  useEffect(() => {
    const mq = matchMedia(narrow);
    const on = () => setCollapsed(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [chatLog, setChatLog] = useState<Ctx['chatLog']>([]);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => { try { return localStorage.getItem('theme') as 'light' | 'dark' | null; } catch { return null; } });
  const toastId = useRef(0);

  useEffect(() => {
    void createApi().then(async a => { setApi(a); setS(await a.snapshot()); setAi(await a.aiStatus()); a.on?.('ai-status', p => setAi(p as AiStatus)); });
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { theme ? localStorage.setItem('theme', theme) : localStorage.removeItem('theme'); } catch { /* storage unavailable */ }
  }, [theme]);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts(l => [{ ...t, id }, ...l].slice(0, 3));
    setTimeout(() => setToasts(l => l.filter(x => x.id !== id)), t.kind === 'change' ? 9000 : 5000);
  }, []);

  const next = useCallback(async () => {
    if (!api || busy) return;
    setBusy(true);
    try {
      const r = await api.next();
      setS(r.snapshot);
      if (!r.processed) { toast({ kind: 'info', title: 'No more demo emails', body: 'Use Reset in the sidebar to replay the scenario.' }); return; }
      announce(r.processed, r.changes, r.snapshot);
      if (r.changes.length) {
        setFlash(new Set(r.changes.map(c => c.itemId)));
        setTimeout(() => setFlash(new Set()), 2600);
      }
    } finally { setBusy(false); }
  }, [api, busy]);

  function announce(p: ProcessedEmail, changes: PriorityChange[], snap: Snapshot) {
    if (p.signals.suspiciousInstructions) {
      toast({ kind: 'danger', title: 'Suspicious email blocked', body: `"${p.email.subject}" from ${p.email.from} tried to instruct the AI. Nothing was changed.` });
      return;
    }
    if (!changes.length) {
      toast({ kind: 'info', title: `New email from ${p.email.fromName}`, body: p.link.itemId ? `${p.signals.summary}. No priority change.` : 'Not related to any ticket.' });
      return;
    }
    for (const c of [...changes].reverse()) {
      const it = snap.items.find(i => i.id === c.itemId)!;
      toast({ kind: 'change', band: c.toBand as Band, itemId: c.itemId, title: `${it.externalId} ${c.fromBand} → ${c.toBand}`, body: c.reason });
    }
  }

  const ctx = useMemo<Ctx | null>(() => api && s ? {
    s, ai, api, busy, flash, routeOpts, chatLog, setChatLog, toast,
    go: (r, opts) => { setRoute(r); setRouteOpts(opts ?? {}); },
    open: id => setItemId(id),
    next,
    setWeights: async w => setS(await api.setWeights(w)),
    handoff: async (i, t) => {
      setS(await api.applyHandoff(i, t));
      toast({ kind: 'ok', title: 'Hand-off approved', body: 'Logged in the audit trail. In production this becomes a suggested reassignment in Siebel or Jira.' });
    },
    override: async (i, b, r) => {
      const snap = await api.setOverride(i, b, r);
      setS(snap);
      const it = snap.items.find(x => x.id === i)!;
      toast({ kind: 'ok', title: b ? `${it.externalId} set to ${b}` : `${it.externalId} back to computed priority`, body: b ? 'Manual priority recorded with your reason.' : undefined });
    },
    chat: (q, h) => api.chat(q, h),
    refreshAi: async () => setAi(await api.aiStatus()),
  } : null, [api, s, ai, busy, flash, routeOpts, chatLog, next, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) void next();
      if (e.key === 'Escape') setItemId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next]);

  if (!ctx) return <div className="empty" style={{ paddingTop: 120 }}>Loading tickets and mailbox…</div>;
  const p1 = ctx.s.scored.filter(x => x.band === 'P1').length;
  const signals = ctx.s.processed.filter(p => p.signals.isEscalation || p.signals.isDeescalation || p.signals.suspiciousInstructions || p.signals.deadline).length;
  const overloaded = ctx.s.loads.filter(l => l.status === 'overloaded').length;

  return (
    <AppCtx.Provider value={ctx}>
      <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
        <header className="topbar">
          <div className="brand">
            <button className="tb-btn" aria-label="Toggle navigation" onClick={() => setCollapsed(c => !c)}><PanelLeft size={18} /></button>
            <span className="logo"><Sparkles size={16} /></span><span className="brand-name">Triage Brain</span>
          </div>
          <GlobalSearch />
          <span className="clock" title="Demo clock">{fmtTime(ctx.s.now)} UTC</span>
          {/* A demo control, not part of the product: styled apart so it does not compete with the work on the page. */}
          <button className="demo-btn" onClick={() => void next()} disabled={busy || !ctx.s.incomingLeft} aria-label="Demo: next email"
            title={ctx.s.nextIncoming ? `Next: ${ctx.s.nextIncoming.fromName}: ${ctx.s.nextIncoming.subject} (shortcut N)` : 'No more demo emails'}>
            <span className="demo-tag">Demo</span><Mail size={15} /><span className="tb-label">{busy ? 'Reading email…' : `Next email (${ctx.s.incomingLeft})`}</span><kbd className="tb-label">N</kbd>
          </button>
          <button className="ai-pill" onClick={() => ctx.go('settings')} title={ai?.message} aria-label={`AI engine: ${ai?.mode === 'local-llm' ? 'local model' : ai?.mode === 'team-hub' ? 'team hub' : 'rule engine'}. Open settings`}>
            <span className={`dot ${ai?.mode === 'rules' ? 'rules' : ''}`} />
            <span className="tb-label">{ai?.mode === 'local-llm' ? `${(ai.emailModel ?? '').replace(/\.gguf$/, '').replace(/^.*?(Qwen)/i, '$1').slice(0, 22)} · ${ai.device ?? 'local'}` : ai?.mode === 'team-hub' ? `Team hub · ${ai.emailModel}` : 'Rule engine'}</span>
          </button>
          <button className="tb-btn" aria-label="Toggle theme" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        </header>
        <nav className="nav" aria-label="Main">
          {NAV.map(n => (
            <button key={n.id} className={route === n.id ? 'active' : ''} aria-current={route === n.id ? 'page' : undefined} aria-label={n.label} onClick={() => ctx.go(n.id)} title={n.label}>
              <n.icon size={18} /><span className="label">{n.label}</span>
              {n.id === 'queue' && <span className={`count ${p1 ? 'alert' : ''}`}>{p1}</span>}
              {n.id === 'inbox' && <span className="count">{signals}</span>}
              {n.id === 'workload' && overloaded > 0 && <span className="count alert">{overloaded}</span>}
            </button>
          ))}
          <div className="section">Governance</div>
          <button className={route === 'audit' ? 'active' : ''} aria-current={route === 'audit' ? 'page' : undefined} aria-label="Audit log" onClick={() => ctx.go('audit')} title="Audit log"><ScrollText size={18} /><span className="label">Audit log</span></button>
          <button className={route === 'settings' ? 'active' : ''} aria-current={route === 'settings' ? 'page' : undefined} aria-label="Settings" onClick={() => ctx.go('settings')} title="Settings"><SettingsIcon size={18} /><span className="label">Settings</span></button>
          <div className="spacer" />
          <button onClick={async () => { setS(await api!.reset()); setChatLog([]); toast({ kind: 'info', title: 'Demo reset', body: 'Back to Tuesday 09:00 with the original data.' }); }} title="Reset demo" aria-label="Reset demo">
            <RotateCcw size={18} /><span className="label">Reset demo</span>
          </button>
          <div className="persona">
            <span className="avatar lg" style={{ background: '#5c2e91' }}>DW</span>
            <div className="small"><b>Dana Whitfield</b><div className="muted">Head of Support{isDesktop ? '' : ' · web demo'}</div></div>
          </div>
        </nav>
        <main className="main">
          {route === 'overview' && <Overview />}
          {route === 'queue' && <Queue />}
          {route === 'inbox' && <Inbox />}
          {route === 'workload' && <Workload />}
          {route === 'assistant' && <Assistant />}
          {route === 'audit' && <Audit />}
          {route === 'settings' && <Settings />}
        </main>
      </div>
      {itemId && <ItemDrawer itemId={itemId} onClose={() => setItemId(null)} />}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind === 'change' ? t.band : t.kind}`}>
            {t.kind === 'danger' ? <ShieldAlert size={20} color="var(--danger)" /> : t.band ? <BandChip band={t.band} /> : <Mail size={18} color="var(--brand)" />}
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              {t.body && <div className="small muted" style={{ marginTop: 2 }}>{t.body}</div>}
              {t.itemId && <button className="btn sm subtle" style={{ marginTop: 6, paddingLeft: 0, color: 'var(--brand-fg)' }} onClick={() => setItemId(t.itemId!)}>Open item <ArrowRight size={12} /></button>}
            </div>
            <button className="btn sm subtle" aria-label="Dismiss" onClick={() => setToasts(l => l.filter(x => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

function GlobalSearch() {
  const { s, open } = useApp();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const cust = new Map(s.customers.map(c => [c.id, c.name]));
    return s.scored.filter(x => `${x.item.externalId} ${x.item.title} ${cust.get(x.item.customerId)}`.toLowerCase().includes(t)).slice(0, 7);
  }, [q, s]);
  const pick = (id: string) => { open(id); setQ(''); };
  return (
    <div className="search">
      <Search size={16} />
      <input value={q} placeholder="Search tickets, customers, ids (e.g. Acme, INT-400)" aria-label="Search"
        onChange={e => { setQ(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') setActive(a => Math.min(a + 1, results.length - 1));
          if (e.key === 'ArrowUp') setActive(a => Math.max(a - 1, 0));
          if (e.key === 'Enter' && results[active]) pick(results[active].item.id);
          if (e.key === 'Escape') setQ('');
        }} />
      {results.length > 0 && (
        <div className="results">
          {results.map((x, i) => (
            <button key={x.item.id} className={i === active ? 'active' : ''} onMouseDown={() => pick(x.item.id)}>
              <BandChip band={x.band} /><span className="mono">{x.item.externalId}</span><span className="grow ellipsis">{x.item.title}</span><SourceBadge source={x.item.source} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
