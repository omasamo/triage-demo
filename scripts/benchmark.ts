// Measures what goes into the pitch: email-triage accuracy against the planted ground truth,
// seconds per email and tokens per second on THIS machine, and chat latency.
//
//   npm run benchmark                 # local model if installed (run `npm run models:pull` first)
//   npm run benchmark -- --engine rules
//   npm run benchmark -- --limit 40   # quicker run
//   npm run benchmark -- --chat large # also time the 4B chat model
//
// Results are printed and saved to bench-results/<machine>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import type { Dataset, Email, EmailSignals, EmailTruth } from '../src/core/types.ts';
import { heuristicSignals } from '../src/core/ai/heuristic.ts';
import { Linker } from '../src/core/linker.ts';
import { Engine } from '../src/core/engine.ts';
import { createBackend, LocalModels } from '../src/node/llm.ts';
import { hardwareInfo, loadConfig } from '../src/node/config.ts';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const data = JSON.parse(readFileSync('data/dataset.json', 'utf8')) as Dataset;
const truth = new Map((JSON.parse(readFileSync('data/truth.json', 'utf8')) as EmailTruth[]).map(t => [t.emailId, t]));

const config = loadConfig();
if (arg('chat')) config.chatModel = arg('chat') as 'small' | 'large';
const want = arg('engine', 'auto');
const backend = want === 'rules' ? null : createBackend(config);
// The app runs the model with a rule safety net (see combineWithRules); that combination is what is measured.
if (backend) await backend.warmup();
const useModel = !!backend?.available;
if (want !== 'rules' && !useModel) console.log('No model available, benchmarking the rule engine. Run `npm run models:pull` to download Qwen3.5-2B.\n');

// Sample: every planted signal email plus routine mail, so a short run still measures what matters.
const all = [...data.emails, ...data.incoming];
const interesting = all.filter(e => truth.get(e.id)!.kind !== 'info' && truth.get(e.id)!.kind !== 'noise');
const routine = all.filter(e => !interesting.includes(e));
const limit = Number(arg('limit', useModel ? '80' : String(all.length)));
const sample: Email[] = [...interesting, ...routine.filter((_, i) => i % Math.max(1, Math.floor(routine.length / Math.max(1, limit - interesting.length))) === 0)].slice(0, Math.max(limit, interesting.length));

const failures: string[] = [];
let rawShown = 0;
type Row = { e: Email; t: EmailTruth; s: EmailSignals; ms: number; tokens: number; promptMs: number; linked: string | null };
async function run(emails: Email[], truthOf: Map<string, EmailTruth>, label: string): Promise<Row[]> {
  const linker = new Linker(data.items, data.customers);
  const rows: Row[] = [];
  for (const [i, e] of [...emails].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).entries()) {
    const t = truthOf.get(e.id)!;
    let s: EmailSignals, ms: number, tokens = 0, promptMs = 0;
    if (useModel) {
      try {
        const r = await backend!.extract(e, data.now);
        ({ signals: s, ms, tokens } = r);
        promptMs = r.promptMs ?? 0;
        if (rawShown++ < 2) console.log(`  raw model output for ${e.id}: ${JSON.stringify(r.raw ?? '').slice(0, 400)}`);
      }
      catch (err) {
        // Count it as a schema failure and score the rule engine's answer for this email.
        if (!failures.length) console.log(`  first model failure on ${e.id}: ${(err as Error).message}`);
        failures.push(e.id); s = heuristicSignals(e, data.now); ms = 0;
      }
    }
    else { const a = performance.now(); s = heuristicSignals(e, data.now); ms = performance.now() - a; }
    const link = s.suspiciousInstructions ? { itemId: null, method: 'none' as const, confidence: 0 } : linker.link(e, s.ticketRefs);
    linker.learn(e, link);
    rows.push({ e, t, s, ms, tokens, promptMs, linked: link.itemId });
    if (useModel && (i + 1) % 10 === 0) console.log(`  ${label}: ${i + 1}/${emails.length} emails, ${(ms / 1000).toFixed(1)} s for the last one`);
  }
  return rows;
}

const pct = (a: number, b: number) => b ? Math.round((a / b) * 1000) / 10 : null;
function metrics(rows: Row[]) {
  const isEsc = (t: EmailTruth) => t.kind === 'escalation';
  const tp = rows.filter(r => isEsc(r.t) && r.s.isEscalation).length;
  const fp = rows.filter(r => !isEsc(r.t) && r.s.isEscalation).length;
  const fn = rows.filter(r => isEsc(r.t) && !r.s.isEscalation).length;
  const withItem = rows.filter(r => r.t.itemId);
  const dlTruth = rows.filter(r => r.t.deadline);
  const dlOk = dlTruth.filter(r => r.s.deadline && Math.abs(Date.parse(r.s.deadline) - Date.parse(r.t.deadline!)) < 36 * 3600_000).length;
  const deesc = rows.filter(r => r.t.kind === 'deescalation');
  const inj = rows.filter(r => r.t.kind === 'injection');
  return {
    emails: rows.length,
    escalation: { precision: pct(tp, tp + fp), recall: pct(tp, tp + fn), tp, fp, fn },
    linking: { accuracy: pct(withItem.filter(r => r.linked === r.t.itemId).length, withItem.length), falseLinks: rows.filter(r => !r.t.itemId && r.linked).length, of: withItem.length },
    deadline: { found: pct(dlOk, dlTruth.length), of: dlTruth.length },
    deescalation: { found: pct(deesc.filter(r => r.s.isDeescalation).length, deesc.length), of: deesc.length },
    injection: { blocked: pct(inj.filter(r => r.s.suspiciousInstructions).length, inj.length), of: inj.length },
    mistakes: [
      ...rows.filter(r => isEsc(r.t) !== r.s.isEscalation).map(r => `${isEsc(r.t) ? 'missed escalation' : 'false alarm'}: ${r.e.subject}`),
      ...dlTruth.filter(r => !(r.s.deadline && Math.abs(Date.parse(r.s.deadline) - Date.parse(r.t.deadline!)) < 36 * 3600_000))
        .map(r => `deadline ${r.s.deadline ?? 'not found'} (expected ${r.t.deadline}): ${r.e.subject}`),
      ...deesc.filter(r => !r.s.isDeescalation).map(r => `missed de-escalation: ${r.e.subject}`),
      ...inj.filter(r => !r.s.suspiciousInstructions).map(r => `missed injection: ${r.e.subject}`),
    ],
  };
}

const holdout = JSON.parse(readFileSync('data/holdout.json', 'utf8')) as { emails: Email[]; truth: EmailTruth[] };
const t0 = performance.now();
const synthRows = await run(sample, truth, 'synthetic');
const holdRows = await run(holdout.emails, new Map(holdout.truth.map(t => [t.emailId, t])), 'hold-out');
const totalMs = performance.now() - t0;
const allRows = [...synthRows, ...holdRows];
const tokens = allRows.reduce((a, r) => a + r.tokens, 0);
const genMs = allRows.reduce((a, r) => a + r.ms, 0);
const promptMs = allRows.reduce((a, r) => a + r.promptMs, 0);
const info = backend instanceof LocalModels ? await backend.info() : undefined;

// ---- chat latency ----
const chat: { q: string; ms: number; tool: string; answer: string }[] = [];
if (useModel) {
  const engine = new Engine(data);
  await engine.ingestHistory();
  const snap = engine.snapshot();
  for (const q of ['What is blocking the Acme go-live?', 'Who is overloaded right now?', 'What should Marek work on first?']) {
    const a = performance.now();
    const r = await backend!.answer(q, [], snap);
    chat.push({ q, ms: Math.round(performance.now() - a), tool: r.toolCalls.join(', '), answer: r.text.slice(0, 300) });
  }
}

const status = backend ? await backend.status() : undefined;
const hw = hardwareInfo();
const result = {
  date: new Date().toISOString(), machine: os.hostname(), ...hw,
  engine: useModel ? status?.emailModel : 'rule engine', device: status?.device ?? 'CPU', chatModel: useModel ? status?.chatModel : undefined,
  schemaFailures: failures.length,
  synthetic: metrics(synthRows),
  holdout: metrics(holdRows),
  speed: {
    secondsPerEmail: Math.round(genMs / allRows.length / 10) / 100,
    // Reading the prompt (time to first token) versus writing the answer, per email.
    promptSecondsPerEmail: promptMs ? Math.round(promptMs / allRows.length / 10) / 100 : undefined,
    tokensPerEmail: tokens ? Math.round(tokens / allRows.length) : undefined,
    tokensPerSecond: tokens ? Math.round(tokens / ((genMs - promptMs) / 1000)) : undefined,
    totalSeconds: Math.round(totalMs / 100) / 10,
  },
  runtime: info,
  chat,
};

console.log(`\nTriage Brain benchmark · ${hw.platform} · ${hw.cpu} · ${hw.ramGb} GB RAM`);
console.log(`Engine: ${result.engine} on ${result.device}${result.chatModel ? ` · chat: ${result.chatModel}` : ''}`);
const row = (m: ReturnType<typeof metrics>) => ({
  'Escalation precision %': m.escalation.precision, 'Escalation recall %': m.escalation.recall,
  'Email→ticket linking %': m.linking.accuracy, 'Deadlines found %': m.deadline.found,
  'De-escalations found %': m.deescalation.found, 'Prompt injections blocked %': m.injection.blocked,
});
console.table({ [`Synthetic set (${result.synthetic.emails})`]: row(result.synthetic), [`Hold-out set (${result.holdout.emails})`]: row(result.holdout) });
if (failures.length) console.log(`Model output could not be parsed for ${failures.length} emails (rule engine used for those).`);
console.log(`Speed: ${result.speed.secondsPerEmail} s per email${result.speed.promptSecondsPerEmail !== undefined ? ` (${result.speed.promptSecondsPerEmail} s reading the prompt, then ${result.speed.tokensPerEmail} tokens at ${result.speed.tokensPerSecond} tokens/s)` : ''}`);
if (info) console.log(`Runtime: ${info.gpu}, ${info.threads ?? '?'} threads, ${info.hybridOrRecurrent ? 'hybrid/recurrent model (prompt prefix needs checkpoints to be reused)' : 'attention model (prompt prefix is reused)'}`);
for (const c of chat) console.log(`Chat "${c.q}" → ${(c.ms / 1000).toFixed(1)} s via ${c.tool}\n   ${c.answer.replace(/\n/g, ' ')}`);
if (result.holdout.mistakes.length) console.log(`\nHold-out mistakes:\n${result.holdout.mistakes.map(m => `  ${m}`).join('\n')}`);
mkdirSync('bench-results', { recursive: true });
const file = `bench-results/${(process.env.BENCH_NAME ?? os.hostname()).replace(/[^a-z0-9-]+/gi, '-')}.json`;
writeFileSync(file, JSON.stringify(result, null, 2));
const md = (m: ReturnType<typeof metrics>) => `${m.escalation.precision ?? '-'} | ${m.escalation.recall ?? '-'} | ${m.linking.accuracy ?? '-'} | ${m.deadline.found ?? '-'} | ${m.deescalation.found ?? '-'} | ${m.injection.blocked ?? '-'}`;
writeFileSync(file.replace(/\.json$/, '.md'), [
  `### ${result.engine} on ${hw.platform} (${hw.cpu}, ${hw.ramGb} GB RAM, ${result.device})`, '',
  '| Set | Escalation precision % | Escalation recall % | Linking % | Deadlines % | De-escalations % | Injections blocked % |',
  '|---|---|---|---|---|---|---|',
  `| Synthetic (${result.synthetic.emails}) | ${md(result.synthetic)} |`,
  `| Hold-out (${result.holdout.emails}) | ${md(result.holdout)} |`, '',
  `Speed: **${result.speed.secondsPerEmail} s per email**${result.speed.promptSecondsPerEmail !== undefined ? ` (${result.speed.promptSecondsPerEmail} s reading the prompt, then ${result.speed.tokensPerEmail} tokens at ${result.speed.tokensPerSecond} tokens/s)` : ''}.`,
  ...chat.map(c => `- Chat "${c.q}": ${(c.ms / 1000).toFixed(1)} s via \`${c.tool}\`. ${c.answer.replace(/\n/g, ' ')}`),
].join('\n') + '\n');
console.log(`\nSaved ${file}`);
await backend?.dispose();
