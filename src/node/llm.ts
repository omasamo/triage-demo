// AI backends for the desktop app and CLI scripts (Node only).
//
// LocalModels runs Qwen3.5 GGUF files in-process with node-llama-cpp (llama.cpp with Metal, CUDA,
// Vulkan or CPU). One small model (Qwen3.5-2B by default) does both jobs so it runs on any laptop:
//   - email triage: output forced into the EmailSignals JSON schema by a grammar, so it is always
//     valid and the model can never "act" on what an email says;
//   - chat, tool-first: the model only picks a structured query (also grammar-constrained), the app
//     runs it against the data, and the model phrases the result. Small models are reliable at both.
// The 4B model can be switched on for chat on 16 GB machines.
//
// ServerModels talks to a company "team hub" (any OpenAI-compatible endpoint: llama.cpp server,
// vLLM, Ollama) with the same prompts and schemas.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Llama, LlamaModel, LlamaContext, LlamaChatSession as Session, LlamaJsonSchemaGrammar } from 'node-llama-cpp';
import type { Email, EmailSignals } from '../core/types.ts';
import type { AiProvider, Snapshot } from '../core/engine.ts';
import type { AiStatus } from '../core/api.ts';
import type { ChatAnswer, ChatTurn } from '../core/chat.ts';
import { ChatTools, answerWithoutModel } from '../core/chat.ts';
import { heuristicSignals } from '../core/ai/heuristic.ts';
import { EMAIL_SIGNALS_SCHEMA, emailSystemPrompt, emailUserPrompt, normalizeSignals } from '../core/ai/schema.ts';
import { TOOL_QUERY_SCHEMA, toolPickerPrompt, answerPrompt, runToolQuery, type ToolQuery } from '../core/ai/chatPlan.ts';
import { type AiConfig, loadConfig, modelsDir } from './config.ts';

export interface AiBackend {
  provider(): AiProvider;
  extract(e: Email, nowIso: string): Promise<{ signals: EmailSignals; tokens: number; ms: number; raw?: string }>;
  answer(question: string, history: ChatTurn[], snap: Snapshot): Promise<ChatAnswer>;
  status(): Promise<AiStatus>;
  warmup(): Promise<void>;
  dispose(): Promise<void>;
  readonly available: boolean;
}

/** Parses the first complete JSON object in a model response (tolerates stray text around it). */
export function parseModelJson<T>(text: string): T {
  try { return JSON.parse(text) as T; } catch { /* fall through to repair and extraction */ }
  // Seen with Qwen3.5 when the thinking budget is 0: the opening brace is swallowed with the
  // closed thought segment and the answer starts at the first key.
  const t = text.trim();
  if (t.startsWith('"')) { try { return JSON.parse(`{${t}${t.endsWith('}') ? '' : '}'}`) as T; } catch { /* keep trying */ } }
  const start = text.indexOf('{');
  let depth = 0, inStr = false, esc = false;
  for (let i = Math.max(0, start); start >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
  }
  throw new Error(`Model returned no JSON object: ${JSON.stringify(text.slice(0, 200))}`);
}

const shortName = (f: string) => path.basename(f).replace(/^hf:/, '').replace(/\.gguf$/i, '').replace(/[:_]/g, ' ');

type Ctx = { context: LlamaContext; session: Session };

export class LocalModels implements AiBackend {
  private llamaP?: Promise<Llama>;
  private models = new Map<string, Promise<LlamaModel>>();
  private ctx: { email?: Ctx; chat?: Ctx } = {};
  private grammars: { email?: LlamaJsonSchemaGrammar<any>; tool?: LlamaJsonSchemaGrammar<any> } = {};
  private state: AiStatus['state'] = 'no-model';
  private message = 'No local model found. Using the rule engine.';
  private queue: Promise<unknown> = Promise.resolve();
  files: { small?: string; large?: string } = {};

  constructor(readonly config: AiConfig = loadConfig(), readonly dir = modelsDir()) {}

  get available() { return !!this.files.small || !!this.files.large; }
  private emailFile() { return this.files.small ?? this.files.large; }
  private chatFile() { return this.config.chatModel === 'large' && this.files.large ? this.files.large : this.emailFile(); }

  private nlc() { return import('node-llama-cpp'); }
  private llama() { return (this.llamaP ??= this.nlc().then(m => m.getLlama(process.env.TRIAGE_GPU === 'false' ? { gpu: false } : undefined))); }

  /** Finds model files on disk. Never downloads (that is `npm run models:pull`). */
  async locate(): Promise<boolean> {
    const { resolveModelFile } = await this.nlc();
    const find = async (uri: string) => {
      if (existsSync(uri)) return uri;
      try { return await resolveModelFile(uri, { directory: this.dir, download: false }); } catch { return undefined; }
    };
    this.files = { small: await find(this.config.models.small), large: await find(this.config.models.large) };
    if (!this.available) { this.state = 'no-model'; this.message = `No model in ${this.dir}. Run "npm run models:pull". Using the rule engine.`; }
    return this.available;
  }

  async pull(which: ('small' | 'large')[] = ['small'], onProgress?: (p: { model: string; downloadedMb: number; totalMb: number }) => void) {
    const { resolveModelFile } = await this.nlc();
    for (const w of which) {
      await resolveModelFile(this.config.models[w], {
        directory: this.dir, cli: !onProgress,
        onProgress: onProgress && (st => onProgress({ model: w, downloadedMb: Math.round(st.downloadedSize / 2 ** 20), totalMb: Math.round(st.totalSize / 2 ** 20) })),
      });
    }
    await this.locate();
  }

  private loadModel(file: string) {
    let m = this.models.get(file);
    if (!m) {
      m = this.llama().then(l => l.loadModel({ modelPath: file })).catch(async err => {
        // Some machines (VMs, old GPUs) report a GPU that cannot actually run the model: fall back to CPU once.
        if (process.env.TRIAGE_GPU === 'false') throw err;
        const { getLlama } = await this.nlc();
        this.llamaP = getLlama({ gpu: false });
        return (await this.llamaP).loadModel({ modelPath: file });
      });
      this.models.set(file, m);
    }
    return m;
  }

  private async context(kind: 'email' | 'chat'): Promise<Ctx> {
    const existing = this.ctx[kind];
    if (existing) return existing;
    const file = kind === 'email' ? this.emailFile() : this.chatFile();
    if (!file) throw new Error('No model file');
    this.state = 'loading'; this.message = `Loading ${path.basename(file)}…`;
    const { LlamaChatSession } = await this.nlc();
    const llama = await this.llama();
    const model = await this.loadModel(file);
    const context = await model.createContext({ contextSize: kind === 'email' ? 4096 : 8192 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    this.ctx[kind] = { context, session };
    this.grammars.email ??= await llama.createGrammarForJsonSchema(EMAIL_SIGNALS_SCHEMA as any);
    this.grammars.tool ??= await llama.createGrammarForJsonSchema(TOOL_QUERY_SCHEMA as any);
    this.state = 'ready'; this.message = 'Local model ready';
    return this.ctx[kind]!;
  }

  async warmup() {
    if (!(await this.locate())) return;
    try { await this.context('email'); } catch (e) { this.state = 'error'; this.message = `Could not load model: ${(e as Error).message}`; }
  }

  /** One generation at a time keeps memory use predictable on laptops. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async extract(e: Email, nowIso: string) {
    return this.exclusive(async () => {
      const { session } = await this.context('email');
      session.setChatHistory([{ type: 'system', text: emailSystemPrompt(nowIso) }]);
      const t0 = performance.now();
      let tokens = 0;
      const out = await session.prompt(emailUserPrompt(e), {
        grammar: this.grammars.email!, maxTokens: 400, temperature: 0, budgets: { thoughtTokens: 0 }, onToken: t => { tokens += t.length; },
      });
      return { signals: normalizeSignals(parseModelJson<Partial<EmailSignals>>(out)), tokens, ms: performance.now() - t0, raw: out };
    });
  }

  provider(): AiProvider {
    return {
      name: `Local ${shortName(this.emailFile() ?? this.config.models.small)}`,
      // A malformed answer never blocks the mailbox: that one email falls back to the rule engine.
      extract: async (e, now) => (await this.extract(e, now).catch(err => { console.warn(`[ai] ${e.id}: ${(err as Error).message}`); return { signals: heuristicSignals(e, now) }; })).signals,
    };
  }

  async answer(question: string, history: ChatTurn[], snap: Snapshot): Promise<ChatAnswer> {
    return this.exclusive(async () => {
      const { session } = await this.context('chat');
      const t0 = performance.now();
      // Step 1: the model picks a tool and its arguments (grammar-constrained JSON).
      session.setChatHistory([{ type: 'system', text: toolPickerPrompt(snap) }]);
      const context = history.slice(-4).map(t => `${t.role}: ${t.text}`).join('\n');
      const raw = await session.prompt(context ? `Conversation so far:\n${context}\n\nNew question: ${question}` : question,
        { grammar: this.grammars.tool!, maxTokens: 120, temperature: 0, budgets: { thoughtTokens: 0 } });
      const query = parseModelJson<ToolQuery>(raw);
      // Step 2: the app runs the query on the data.
      const tools = new ChatTools(snap);
      const result = runToolQuery(tools, query);
      // Step 3: the model phrases the answer from the result only.
      session.setChatHistory([{ type: 'system', text: answerPrompt(snap) }]);
      const text = await session.prompt(`Question: ${question}\n\nData (JSON):\n${JSON.stringify(result).slice(0, 6000)}`,
        { maxTokens: 350, temperature: 0.2, budgets: { thoughtTokens: 0 } });
      return { text: text.trim(), refs: tools.refsIn(text + JSON.stringify(result)).slice(0, 12), engine: `Local ${shortName(this.chatFile()!)}`,
        toolCalls: [`${query.tool}(${JSON.stringify(query.args ?? {})})`], latencyMs: Math.round(performance.now() - t0) };
    });
  }

  async status(): Promise<AiStatus> {
    const llama = this.state === 'ready' ? await this.llama() : undefined;
    return {
      mode: this.available && this.state !== 'error' ? 'local-llm' : 'rules', state: this.state, message: this.message,
      emailModel: this.emailFile() ? path.basename(this.emailFile()!) : undefined,
      chatModel: this.chatFile() ? path.basename(this.chatFile()!) : undefined,
      device: llama ? (llama.gpu ? `GPU (${llama.gpu})` : 'CPU') : undefined,
    };
  }

  async dispose() {
    for (const c of [this.ctx.email, this.ctx.chat]) await c?.context.dispose();
    for (const m of this.models.values()) await (await m).dispose();
    this.ctx = {}; this.models.clear();
  }
}

/** Team hub mode: same prompts and schemas against an OpenAI-compatible server on the company network. */
export class ServerModels implements AiBackend {
  private ok = false;
  private message = 'Not connected';
  constructor(readonly config: AiConfig = loadConfig()) {}
  get available() { return this.ok; }

  private async complete(messages: { role: string; content: string }[], schema?: object, maxTokens = 400): Promise<string> {
    const { url, model, apiKey } = this.config.server;
    const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model, messages, temperature: 0, max_tokens: maxTokens,
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema, strict: true } } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Team hub returned ${res.status}`);
    const j = await res.json() as { choices: { message: { content: string } }[] };
    return j.choices[0].message.content;
  }

  async warmup() {
    try {
      const r = await fetch(`${this.config.server.url.replace(/\/$/, '')}/models`, { headers: this.config.server.apiKey ? { authorization: `Bearer ${this.config.server.apiKey}` } : {} });
      this.ok = r.ok; this.message = r.ok ? `Connected to team hub ${this.config.server.url}` : `Team hub returned ${r.status}`;
    } catch (e) { this.ok = false; this.message = `Cannot reach team hub: ${(e as Error).message}`; }
  }

  async extract(e: Email, nowIso: string) {
    const t0 = performance.now();
    const out = await this.complete([{ role: 'system', content: emailSystemPrompt(nowIso) }, { role: 'user', content: emailUserPrompt(e) }], EMAIL_SIGNALS_SCHEMA);
    return { signals: normalizeSignals(parseModelJson(out)), tokens: 0, ms: performance.now() - t0 };
  }

  provider(): AiProvider { return { name: `Team hub ${this.config.server.model}`, extract: async (e, now) => (await this.extract(e, now)).signals }; }

  async answer(question: string, history: ChatTurn[], snap: Snapshot): Promise<ChatAnswer> {
    const t0 = performance.now();
    try {
      const ctx = history.slice(-4).map(t => `${t.role}: ${t.text}`).join('\n');
      const query = parseModelJson<ToolQuery>(await this.complete([{ role: 'system', content: toolPickerPrompt(snap) },
        { role: 'user', content: ctx ? `Conversation so far:\n${ctx}\n\nNew question: ${question}` : question }], TOOL_QUERY_SCHEMA, 120)) as ToolQuery;
      const tools = new ChatTools(snap);
      const result = runToolQuery(tools, query);
      const text = await this.complete([{ role: 'system', content: answerPrompt(snap) },
        { role: 'user', content: `Question: ${question}\n\nData (JSON):\n${JSON.stringify(result).slice(0, 6000)}` }], undefined, 350);
      return { text: text.trim(), refs: tools.refsIn(text + JSON.stringify(result)).slice(0, 12), engine: `Team hub ${this.config.server.model}`,
        toolCalls: [`${query.tool}(${JSON.stringify(query.args ?? {})})`], latencyMs: Math.round(performance.now() - t0) };
    } catch {
      return { ...answerWithoutModel(question, snap), engine: 'Rule engine (team hub unreachable)' };
    }
  }

  async status(): Promise<AiStatus> {
    return { mode: this.ok ? 'team-hub' : 'rules', state: this.ok ? 'ready' : 'error', message: this.message, emailModel: this.config.server.model, chatModel: this.config.server.model, device: 'Team hub server' };
  }
  async dispose() { /* nothing held */ }
}

export function createBackend(config: AiConfig = loadConfig()): AiBackend {
  return config.mode === 'server' && config.server.url ? new ServerModels(config) : new LocalModels(config);
}
