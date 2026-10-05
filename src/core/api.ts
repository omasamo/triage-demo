// The one interface the UI talks to. Implemented in-process (web demo, Electron main process)
// and over IPC (Electron renderer).
import type { Snapshot } from './engine.ts';
import { Engine } from './engine.ts';
import type { ChatAnswer, ChatTurn } from './chat.ts';
import { answerWithoutModel } from './chat.ts';
import type { Band, Dataset, PriorityChange, ProcessedEmail, Weights } from './types.ts';

export interface AiStatus {
  mode: 'rules' | 'local-llm' | 'team-hub';
  emailModel?: string;
  chatModel?: string;
  device?: string;
  state: 'ready' | 'loading' | 'no-model' | 'error';
  message: string;
}

export interface NextResult { snapshot: Snapshot; processed: ProcessedEmail | null; changes: PriorityChange[] }

export interface TriageApi {
  snapshot(): Promise<Snapshot>;
  next(): Promise<NextResult>;
  setWeights(w: Partial<Weights>): Promise<Snapshot>;
  applyHandoff(itemId: string, toId: string): Promise<Snapshot>;
  setOverride(itemId: string, band: Band | null, reason: string): Promise<Snapshot>;
  chat(question: string, history: ChatTurn[]): Promise<ChatAnswer>;
  aiStatus(): Promise<AiStatus>;
  reset(): Promise<Snapshot>;
}

export type ChatFn = (question: string, history: ChatTurn[], snapshot: Snapshot) => Promise<ChatAnswer>;

export class LocalApi implements TriageApi {
  private engine!: Engine;
  private ready: Promise<void>;

  constructor(private data: Dataset, private opts: {
    makeEngine?: (d: Dataset) => Promise<Engine>;
    chatFn?: ChatFn;
    status?: () => AiStatus | Promise<AiStatus>;
    onChange?: (engine: Engine) => void;
  } = {}) {
    this.ready = this.init();
  }

  private async init() {
    this.engine = this.opts.makeEngine ? await this.opts.makeEngine(this.data) : new Engine(this.data);
    if (!this.opts.makeEngine) await this.engine.ingestHistory();
  }

  async snapshot() { await this.ready; return this.engine.snapshot(); }
  async next(): Promise<NextResult> {
    await this.ready;
    const r = await this.engine.receiveNext();
    this.opts.onChange?.(this.engine);
    return { snapshot: this.engine.snapshot(), processed: r?.processed ?? null, changes: r?.changes ?? [] };
  }
  async setWeights(w: Partial<Weights>) { await this.ready; this.engine.setWeights(w); return this.changed(); }
  async applyHandoff(itemId: string, toId: string) { await this.ready; this.engine.applyHandoff(itemId, toId); return this.changed(); }
  async setOverride(itemId: string, band: Band | null, reason: string) { await this.ready; this.engine.setOverride(itemId, band, reason); return this.changed(); }
  private changed() { this.opts.onChange?.(this.engine); return this.engine.snapshot(); }
  async getEngine() { await this.ready; return this.engine; }
  async chat(q: string, history: ChatTurn[]) {
    await this.ready;
    const snap = this.engine.snapshot();
    const t0 = performance.now();
    const a = this.opts.chatFn ? await this.opts.chatFn(q, history, snap) : answerWithoutModel(q, snap);
    return { ...a, latencyMs: a.latencyMs ?? Math.round(performance.now() - t0) };
  }
  async aiStatus(): Promise<AiStatus> {
    return (await this.opts.status?.()) ?? { mode: 'rules', state: 'no-model', message: 'Web demo: rule engine in the browser. The desktop app runs Qwen3.5 locally.' };
  }
  async reset() { this.ready = this.init(); await this.ready; return this.engine.snapshot(); }
}
