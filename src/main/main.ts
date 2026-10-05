// Electron main process: owns the engine, the local model and the SQLite store.
// The renderer talks to it only through the narrow IPC API below (contextIsolation on, no Node in the UI).
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dataset from '../../data/dataset.json' with { type: 'json' };
import holdout from '../../data/holdout.json' with { type: 'json' };
import type { Dataset, Email } from '../core/types.ts';
import { Engine, heuristicProvider } from '../core/engine.ts';
import { readAheadProvider, type ReadAheadProvider } from '../node/readahead.ts';
import { LocalApi } from '../core/api.ts';
import { answerWithoutModel } from '../core/chat.ts';
import { createBackend, LocalModels, type AiBackend } from '../node/llm.ts';
import { hardwareInfo, loadConfig, saveConfig, modelsDir, type AiConfig } from '../node/config.ts';
import { openStore } from './store.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = dataset as unknown as Dataset;
let config = loadConfig();
let backend: AiBackend = createBackend(config);
const store = openStore(path.join(app.getPath('userData'), 'triage.db'));
let win: BrowserWindow | null = null;

let reader: ReadAheadProvider | null = null;
const readAhead = async () => { if (reader) await reader.readAhead((await api.getEngine()).snapshot().incomingLeft); };

const api = new LocalApi(data, {
  makeEngine: async d => {
    const engine = new Engine(d, heuristicProvider);
    // Reuse signals from earlier model runs; everything else is analysed by the rule engine at start-up.
    await engine.ingestHistory(store.cachedSignals());
    for (const o of store.overrides()) engine.overrides.set(o.itemId, o);
    if (reader) engine.ai = reader;
    return engine;
  },
  chatFn: async (q, history, snap) => backend.available ? backend.answer(q, history, snap).catch(() => answerWithoutModel(q, snap)) : answerWithoutModel(q, snap),
  status: () => backend.status(),
  onChange: engine => {
    store.saveOverrides([...engine.overrides.values()]);
    store.appendAudit(engine.audit.slice(0, 20));
    for (const p of engine.processed.slice(-3)) if (p.engine !== heuristicProvider.name) store.saveSignals(p.email.id, p.engine, p.signals);
  },
});

async function startAi() {
  await backend.warmup();
  if (backend.available) {
    reader = readAheadProvider(backend, data.incoming, data.now);
    (await api.getEngine()).ai = reader;
  }
  win?.webContents.send('ai-status', await backend.status());
  void readAhead();
}

/** Stops background reading before the backend is replaced or disposed. */
function stopAi() { reader?.stop(); reader = null; }

/** "Test this computer" in Settings: six hold-out emails in four languages plus one chat question. */
const SPEED_SAMPLE = ['h-001', 'h-002', 'h-003', 'h-005', 'h-013', 'h-018'];
async function speedTest() {
  if (!backend.available) return { error: 'No model is running. Download Qwen3.5-2B first.' };
  const emails = (holdout as unknown as { emails: Email[] }).emails.filter(e => SPEED_SAMPLE.includes(e.id));
  const runs: { ms: number; tokens: number; promptMs?: number }[] = [];
  for (const e of emails) {
    runs.push(await backend.extract(e, data.now));
    win?.webContents.send('speedtest-progress', { done: runs.length, total: emails.length + 1 });
  }
  const chat = await backend.answer('What is blocking the Acme go-live?', [], (await api.getEngine()).snapshot());
  const ms = runs.reduce((a, r) => a + r.ms, 0) / runs.length;
  const genMs = runs.reduce((a, r) => a + r.ms - (r.promptMs ?? 0), 0);
  const tokens = runs.reduce((a, r) => a + r.tokens, 0);
  const st = await backend.status();
  return {
    model: st.emailModel, device: st.device, hardware: hardwareInfo(), emails: runs.length,
    secondsPerEmail: Math.round(ms / 100) / 10, emailsPerHour: Math.round(3600_000 / ms),
    tokensPerSecond: tokens && genMs ? Math.round(tokens / (genMs / 1000)) : undefined,
    chatSeconds: Math.round((chat.latencyMs ?? 0) / 100) / 10,
  };
}

const methods = {
  snapshot: () => api.snapshot(),
  next: async () => { const r = await api.next(); void readAhead(); return r; },
  setWeights: (w: never) => api.setWeights(w),
  applyHandoff: (itemId: string, toId: string) => api.applyHandoff(itemId, toId),
  setOverride: (itemId: string, band: never, reason: string) => api.setOverride(itemId, band, reason),
  chat: (q: string, h: never) => api.chat(q, h),
  aiStatus: () => api.aiStatus(),
  reset: async () => { const s = await api.reset(); void readAhead(); return s; },
  settings: async () => ({ config, hardware: hardwareInfo(), modelsDir: modelsDir(), store: store.kind }),
  saveSettings: async (c: AiConfig) => {
    config = c; saveConfig(c);
    stopAi(); await backend.dispose(); backend = createBackend(config);
    const engine = await api.getEngine(); engine.ai = heuristicProvider;
    void startAi();
    return { config, hardware: hardwareInfo(), modelsDir: modelsDir(), store: store.kind };
  },
  /** Re-analyse the whole mailbox history with the model (for the proof-point numbers). */
  reanalyse: async () => {
    if (!backend.available) return { done: 0, error: 'No model available' };
    const engine = await api.getEngine();
    let done = 0;
    for (const e of data.emails) {
      const { signals } = await backend.extract(e, data.now);
      store.saveSignals(e.id, backend.provider().name, signals);
      if (++done % 5 === 0) win?.webContents.send('reanalyse-progress', { done, total: data.emails.length });
    }
    await api.reset();
    return { done, engine: engine.ai.name };
  },
  /** Downloads the local model(s) from inside the app, so installer users need no command line. */
  downloadModels: async (which: ('small' | 'large')[]) => {
    const local = backend instanceof LocalModels ? backend : new LocalModels(config);
    let last = 0;
    await local.pull(which, p => { if (Date.now() - last > 400) { last = Date.now(); win?.webContents.send('download-progress', p); } });
    stopAi(); await backend.dispose(); backend = createBackend(config);
    void startAi();
    return { ok: true };
  },
  speedTest,
  openExternal: (url: string) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); },
} as const;

ipcMain.handle('triage', async (_e, method: keyof typeof methods, ...args: unknown[]) => {
  const fn = methods[method] as (...a: unknown[]) => Promise<unknown>;
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...args);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, title: 'Triage Brain', backgroundColor: '#f5f5f5',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  if (process.env.VITE_DEV_URL) void win.loadURL(process.env.VITE_DEV_URL);
  else void win.loadFile(path.join(here, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  if (process.argv.includes('--smoke')) {
    // CI check: the window loads, the UI renders data from the main process over IPC, then exit.
    win!.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 4000));
      const text: string = await win!.webContents.executeJavaScript('document.body.innerText');
      const ok = text.includes('Good morning') && text.includes('Top priorities');
      console.log(ok ? `SMOKE OK (${store.kind})` : `SMOKE FAILED:\n${text.slice(0, 500)}`);
      app.exit(ok ? 0 : 1);
    });
  }
  void startAi();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { void backend.dispose(); });
