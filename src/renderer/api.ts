// Picks the backend: the Electron main process over IPC, or the engine in the browser (web demo).
import type { TriageApi, AiStatus } from '../core/api.ts';
import { LocalApi } from '../core/api.ts';
import type { Dataset } from '../core/types.ts';
import type { AiConfig } from '../node/config.ts';

export interface SpeedResult {
  error?: string;
  model?: string; device?: string; emails?: number;
  hardware?: DesktopSettings['hardware'];
  secondsPerEmail?: number; emailsPerHour?: number; tokensPerSecond?: number; chatSeconds?: number;
}

export interface DesktopSettings {
  config: AiConfig;
  hardware: { ramGb: number; cpu: string; cores: number; platform: string; recommendedChat: 'small' | 'large' };
  modelsDir: string;
  store: string;
}

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (p: unknown) => void): () => void;
  desktop: true;
}
declare global { interface Window { triage?: Bridge } }

export const isDesktop = typeof window !== 'undefined' && !!window.triage;

class IpcApi implements TriageApi {
  constructor(private b: Bridge) {}
  private c = <T,>(m: string, ...a: unknown[]) => this.b.call(m, ...a) as Promise<T>;
  snapshot = () => this.c<any>('snapshot');
  next = () => this.c<any>('next');
  setWeights = (w: unknown) => this.c<any>('setWeights', w);
  applyHandoff = (i: string, t: string) => this.c<any>('applyHandoff', i, t);
  setOverride = (i: string, b: unknown, r: string) => this.c<any>('setOverride', i, b, r);
  chat = (q: string, h: unknown) => this.c<any>('chat', q, h);
  aiStatus = () => this.c<AiStatus>('aiStatus');
  reset = () => this.c<any>('reset');
  settings = () => this.c<DesktopSettings>('settings');
  saveSettings = (c: AiConfig) => this.c<DesktopSettings>('saveSettings', c);
  reanalyse = () => this.c<{ done: number; error?: string }>('reanalyse');
  downloadModels = (which: ('small' | 'large')[]) => this.c<{ ok: boolean }>('downloadModels', which);
  speedTest = () => this.c<SpeedResult>('speedTest');
  on = (ch: string, cb: (p: unknown) => void) => this.b.on(ch, cb);
}

export type ClientApi = TriageApi & Partial<Pick<IpcApi, 'settings' | 'saveSettings' | 'reanalyse' | 'downloadModels' | 'speedTest' | 'on'>>;

export async function createApi(): Promise<ClientApi> {
  if (window.triage) return new IpcApi(window.triage);
  const { default: data } = await import('../../data/dataset.json');
  return new LocalApi(data as unknown as Dataset);
}
