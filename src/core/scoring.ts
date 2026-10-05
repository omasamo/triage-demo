// Explainable priority score: a sum of named factors. The AI only supplies signals (escalation,
// deadline, sentiment...) from emails; the arithmetic is deterministic and auditable.
import type { Band, Customer, FactorKey, ManualOverride, ProcessedEmail, ScoreFactor, ScoredItem, Weights, WorkItem } from './types.ts';

export const FACTOR_LABELS: Record<FactorKey, string> = {
  severity: 'Severity', sla: 'SLA time left', tier: 'Customer tier', escalation: 'Email escalation',
  executive: 'Executive involved', deadline: 'Deadline', sentiment: 'Customer sentiment', stale: 'No recent update',
  blocking: 'Blocks other work', waiting: 'Waiting on customer', deescalation: 'Customer de-escalated', goLive: 'Go-live soon',
  override: 'Manager override',
};

export const DEFAULT_WEIGHTS: Weights = {
  severity: 1, sla: 1, tier: 1, escalation: 1, executive: 1, deadline: 1,
  sentiment: 1, stale: 1, blocking: 1, waiting: 1, deescalation: 1, goLive: 1,
};

export const BAND_RANGE: Record<Band, [number, number]> = { P1: [90, Infinity], P2: [60, 89], P3: [35, 59], P4: [0, 34] };

export function band(score: number): Band {
  return score >= 90 ? 'P1' : score >= 60 ? 'P2' : score >= 35 ? 'P3' : 'P4';
}

const HOUR = 3600_000;
const hoursLeft = (iso: string, now: number) => (Date.parse(iso) - now) / HOUR;
export function fmtHours(h: number) {
  const a = Math.abs(h);
  const s = a < 1 ? `${Math.round(a * 60)} min` : a < 48 ? `${Math.round(a)} h` : `${Math.round(a / 24)} days`;
  return h < 0 ? `${s} ago` : `in ${s}`;
}

export interface ScoreContext {
  now: number;
  weights: Weights;
  customers: Map<string, Customer>;
  emailsByItem: Map<string, ProcessedEmail[]>; // sorted by receivedAt ascending
  items: Map<string, WorkItem>;
  overrides?: Map<string, ManualOverride>;
}

/** Factors that come from email signals; reused when a blocker inherits urgency from what it blocks. */
function signalFactors(it: WorkItem, ctx: ScoreContext): ScoreFactor[] {
  const out: ScoreFactor[] = [];
  const mails = (ctx.emailsByItem.get(it.id) ?? []).filter(p => ctx.now - Date.parse(p.email.receivedAt) < 7 * 24 * HOUR);
  // Only signals after the latest de-escalation count.
  let lastDeesc = -1;
  mails.forEach((p, i) => { if (p.signals.isDeescalation) lastDeesc = i; });
  const live = mails.slice(lastDeesc + 1).filter(p => !p.signals.suspiciousInstructions);

  const esc = live.filter(p => p.signals.isEscalation);
  if (esc.length) {
    const rank = { critical: 35, high: 22, medium: 10, low: 0, none: 0 } as const;
    const top = esc.reduce((a, b) => (rank[b.signals.urgency] >= rank[a.signals.urgency] ? b : a));
    out.push({ key: 'escalation', label: FACTOR_LABELS.escalation, points: rank[top.signals.urgency],
      detail: `${top.email.fromName}: "${top.signals.evidence}"`, emailId: top.email.id });
    const ex = esc.find(p => p.signals.executiveInvolved);
    if (ex) out.push({ key: 'executive', label: FACTOR_LABELS.executive, points: 10, detail: `Executive attention in mail from ${ex.email.fromName}`, emailId: ex.email.id });
  }
  const dl = live.filter(p => p.signals.deadline).map(p => ({ p, h: hoursLeft(p.signals.deadline!, ctx.now) }))
    .filter(x => x.h > -24).sort((a, b) => a.h - b.h)[0];
  if (dl) {
    const pts = dl.h < 24 ? 25 : dl.h < 48 ? 18 : dl.h < 120 ? 10 : 4;
    out.push({ key: 'deadline', label: FACTOR_LABELS.deadline, points: pts, detail: `Deadline ${fmtHours(dl.h)} (from ${dl.p.email.fromName}'s email)`, emailId: dl.p.email.id, at: dl.p.signals.deadline! });
  }
  const lastCustomer = [...live].reverse().find(p => !p.email.from.endsWith('northstar-support.example'));
  if (lastCustomer && (lastCustomer.signals.sentiment === 'angry' || lastCustomer.signals.sentiment === 'frustrated')) {
    out.push({ key: 'sentiment', label: FACTOR_LABELS.sentiment, points: lastCustomer.signals.sentiment === 'angry' ? 8 : 4,
      detail: `${lastCustomer.email.fromName} sounds ${lastCustomer.signals.sentiment}`, emailId: lastCustomer.email.id });
  }
  if (lastDeesc >= 0 && !esc.length) {
    const d = mails[lastDeesc];
    out.push({ key: 'deescalation', label: FACTOR_LABELS.deescalation, points: -25, detail: `${d.email.fromName}: "${d.signals.evidence}"`, emailId: d.email.id });
  }
  return out;
}

function baseFactors(it: WorkItem, ctx: ScoreContext): ScoreFactor[] {
  const out: ScoreFactor[] = [];
  const sevPts = { 1: 40, 2: 25, 3: 12, 4: 3 }[it.severity];
  out.push({ key: 'severity', label: FACTOR_LABELS.severity, points: sevPts, detail: `Severity ${it.severity} in ${it.source === 'siebel' ? 'Siebel' : 'Jira'}` });
  const h = hoursLeft(it.slaDueAt, ctx.now);
  const slaPts = h < 0 ? 40 : h < 4 ? 30 : h < 12 ? 20 : h < 24 ? 14 : h < 72 ? 6 : 0;
  if (slaPts) out.push({ key: 'sla', label: FACTOR_LABELS.sla, points: slaPts, detail: h < 0 ? `SLA breached ${fmtHours(h)}` : `SLA due ${fmtHours(h)}` });
  const c = ctx.customers.get(it.customerId)!;
  const tierPts = { Platinum: 12, Gold: 8, Silver: 4, Bronze: 0 }[c.tier];
  if (tierPts) out.push({ key: 'tier', label: FACTOR_LABELS.tier, points: tierPts, detail: `${c.name} is a ${c.tier} customer` });
  if (it.goLiveAt) {
    const g = hoursLeft(it.goLiveAt, ctx.now);
    if (g > -24 && g < 120) out.push({ key: 'goLive', label: FACTOR_LABELS.goLive, points: 8, detail: `Planned go-live ${fmtHours(g)}` });
  }
  const idle = (ctx.now - Date.parse(it.updatedAt)) / HOUR;
  if (idle > 72 && it.status !== 'Waiting on Customer') out.push({ key: 'stale', label: FACTOR_LABELS.stale, points: 6, detail: `Not updated for ${Math.round(idle / 24)} days` });
  if (it.status === 'Waiting on Customer') out.push({ key: 'waiting', label: FACTOR_LABELS.waiting, points: -15, detail: 'Ball is in the customer\'s court' });
  return out;
}

export function scoreAll(items: WorkItem[], ctx: ScoreContext): Map<string, ScoredItem> {
  const open = items.filter(i => i.status !== 'Resolved');
  const signalMap = new Map(open.map(i => [i.id, signalFactors(i, ctx)]));
  // Reverse index: which open items does each item block?
  const blocks = new Map<string, WorkItem[]>();
  for (const it of open) for (const b of it.blockedByIds) blocks.set(b, [...(blocks.get(b) ?? []), it]);

  const result = new Map<string, ScoredItem>();
  for (const it of open) {
    const factors = [...baseFactors(it, ctx), ...signalMap.get(it.id)!];
    const dependents = blocks.get(it.id) ?? [];
    if (dependents.length) {
      const inherited = Math.max(0, ...dependents.map(d => (signalMap.get(d.id) ?? [])
        .filter(f => f.key === 'escalation' || f.key === 'deadline' || f.key === 'executive').reduce((s, f) => s + f.points, 0)));
      const pts = 6 * dependents.length + Math.round(inherited * 0.8);
      const urgentDep = dependents.find(d => (signalMap.get(d.id) ?? []).some(f => f.key === 'escalation' || f.key === 'deadline'));
      factors.push({ key: 'blocking', label: FACTOR_LABELS.blocking, points: pts,
        detail: urgentDep ? `Blocks ${urgentDep.externalId}, which the customer escalated` : `Blocks ${dependents.map(d => d.externalId).join(', ')}` });
    }
    for (const f of factors) f.points = Math.round(f.points * (ctx.weights[f.key as keyof Weights] ?? 1));
    let score = Math.max(0, factors.reduce((s, f) => s + f.points, 0));
    const ov = ctx.overrides?.get(it.id);
    if (ov) {
      // Move the score just inside the band the manager chose; the factor shows exactly how much.
      const [lo, hi] = BAND_RANGE[ov.band];
      const target = score < lo ? lo + 5 : score > hi ? hi - 5 : score;
      factors.push({ key: 'override', label: FACTOR_LABELS.override, points: target - score, detail: `${ov.by} set ${ov.band}: ${ov.reason}` });
      score = target;
    }
    result.set(it.id, { item: it, score, band: band(score), override: ov,
      factors: factors.filter(f => f.points !== 0 || f.key === 'override').sort((a, b) => Number(b.key === 'override') - Number(a.key === 'override') || Math.abs(b.points) - Math.abs(a.points)) });
  }
  return result;
}
