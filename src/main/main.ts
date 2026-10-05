// Electron main process: owns the engine, the local model and the SQLite store.
// The renderer talks to it only through the narrow IPC API below (contextIsolation on, no Node in the UI).
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dataset from '../../data/dataset.json' with { type: 'json' };
import type { Dataset } from '../core/types.ts';
import { Engine, heuristicProvider } from '../core/engine.ts';
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

const api = new LocalApi(data, {
  makeEngine: async d => {
    const engine = new Engine(d, heuristicProvider);
    // Reuse signals from earlier model runs; everything else is analysed by the rule engine at start-up.
    await engine.ingestHistory(store.cachedSignals());
    for (const o of store.overrides()) engine.overrides.set(o.itemId, o);
    if (backend.available) engine.ai = backend.provider();
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
  if (backend.available) (await api.getEngine()).ai = backend.provider();
  win?.webContents.send('ai-status', await backend.status());
}

const methods = {
  snapshot: () => api.snapshot(),
  next: () => api.next(),
  setWeights: (w: never) => api.setWeights(w),
  applyHandoff: (itemId: string, toId: string) => api.applyHandoff(itemId, toId),
  setOverride: (itemId: string, band: never, reason: string) => api.setOverride(itemId, band, reason),
  chat: (q: string, h: never) => api.chat(q, h),
  aiStatus: () => api.aiStatus(),
  reset: () => api.reset(),
  settings: async () => ({ config, hardware: hardwareInfo(), modelsDir: modelsDir(), store: store.kind }),
  saveSettings: async (c: AiConfig) => {
    config = c; saveConfig(c);
    await backend.dispose(); backend = createBackend(config);
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
    await backend.dispose(); backend = createBackend(config);
    void startAi();
    return { ok: true };
  },
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
