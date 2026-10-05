// AI configuration for the desktop app and CLI scripts.
// Stored at ~/.triage-demo/config.json (or $TRIAGE_HOME/config.json) and editable from Settings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AiConfig {
  /** auto: local model if installed, else rule engine. server: company "team hub" endpoint. */
  mode: 'auto' | 'local' | 'server' | 'rules';
  models: { small: string; large: string };
  /** Which local model answers chat questions. Email triage always uses the small model. */
  chatModel: 'small' | 'large';
  /** Team hub: any OpenAI-compatible endpoint (llama.cpp server, vLLM, Ollama) inside the company network. */
  server: { url: string; model: string; apiKey: string };
}

export const DEFAULT_CONFIG: AiConfig = {
  mode: 'auto',
  models: {
    // Apache 2.0 weights, quantized to 4 bit. Any GGUF path or hf: URI works here.
    small: 'hf:bartowski/Qwen_Qwen3.5-2B-GGUF:Q4_K_M',   // ~1.5 GB, runs on any 8 GB laptop
    large: 'hf:bartowski/Qwen_Qwen3.5-4B-GGUF:Q4_K_M',   // ~3 GB, better chat answers on 16 GB+
  },
  chatModel: 'small',
  server: { url: '', model: 'qwen3.5-9b', apiKey: '' },
};

export const triageHome = () => process.env.TRIAGE_HOME ?? path.join(os.homedir(), '.triage-demo');
export const modelsDir = () => process.env.TRIAGE_MODELS_DIR ?? path.join(triageHome(), 'models');
const configFile = () => path.join(triageHome(), 'config.json');

export function loadConfig(): AiConfig {
  let file: Partial<AiConfig> = {};
  if (existsSync(configFile())) { try { file = JSON.parse(readFileSync(configFile(), 'utf8')); } catch { /* fall back to defaults */ } }
  const c: AiConfig = {
    ...DEFAULT_CONFIG, ...file,
    models: { ...DEFAULT_CONFIG.models, ...file.models },
    server: { ...DEFAULT_CONFIG.server, ...file.server },
  };
  if (process.env.TRIAGE_AI_MODE) c.mode = process.env.TRIAGE_AI_MODE as AiConfig['mode'];
  if (process.env.TRIAGE_SERVER_URL) { c.server.url = process.env.TRIAGE_SERVER_URL; if (c.mode === 'auto') c.mode = 'server'; }
  return c;
}

export function saveConfig(c: AiConfig) {
  mkdirSync(triageHome(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

/** Hardware hint shown in Settings: the 4B chat model is suggested on machines with 16 GB RAM or more. */
export function hardwareInfo() {
  const ramGb = Math.round(os.totalmem() / 2 ** 30);
  return {
    ramGb, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, platform: `${os.platform()} ${os.arch()}`,
    recommendedChat: (ramGb >= 16 ? 'large' : 'small') as AiConfig['chatModel'],
  };
}
