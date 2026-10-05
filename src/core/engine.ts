// The "central brain": ingests work items and emails from connectors, links and classifies emails,
// scores everything, models workload and produces reminders and hand-off suggestions.
// Pure TypeScript with no Node or browser dependencies, so it runs in Electron's main process
// and in the browser (web demo) unchanged.
import type {
  Band, Customer, Dataset, Email, EmailSignals, Handoff, ManualOverride, PersonLoad, PriorityChange, ProcessedEmail, Reminder,
  ScoredItem, Team, Person, Weights, WorkItem,
} from './types.ts';
import { Linker } from './linker.ts';
import { DEFAULT_WEIGHTS, fmtHours, scoreAll } from './scoring.ts';
import { computeLoads, suggestHandoffs } from './workload.ts';
import { heuristicSignals } from './ai/heuristic.ts';

export interface AiProvider {
  readonly name: string;
  extract(email: Email, nowIso: string): Promise<EmailSignals>;
}

export const heuristicProvider: AiProvider = {
  name: 'Rule engine',
  extract: async (e, now) => heuristicSignals(e, now),
};

export interface AuditEntry {
  at: string;
  kind: 'ai-signal' | 'priority-change' | 'handoff-applied' | 'weights-changed' | 'injection-blocked' | 'manual-override';
  message: string;
  itemId?: string;
  emailId?: string;
  engine?: string;
}

export interface Snapshot {
  now: string;
  teams: Team[];
  people: Person[];
  customers: Customer[];
  items: WorkItem[];
  scored: ScoredItem[];
  loads: PersonLoad[];
  handoffs: Handoff[];
  reminders: Reminder[];
  processed: ProcessedEmail[];
  changes: PriorityChange[];
  audit: AuditEntry[];
  weights: Weights;
  overrides: ManualOverride[];
  incomingLeft: number;
  nextIncoming?: { fromName: string; subject: string };
}

export class Engine {
  now: number;
  weights: Weights = { ...DEFAULT_WEIGHTS };
  readonly items: WorkItem[];
  readonly customers: Map<string, Customer>;
  processed: ProcessedEmail[] = [];
  changes: PriorityChange[] = [];
  audit: AuditEntry[] = [];
  overrides = new Map<string, ManualOverride>();
  private linker: Linker;
  private incoming: Email[];
  private scoredCache: Map<string, ScoredItem> | null = null;

  constructor(readonly data: Dataset, public ai: AiProvider = heuristicProvider) {
    this.now = Date.parse(data.now);
    this.items = structuredClone(data.items);
    this.customers = new Map(data.customers.map(c => [c.id, c]));
    this.linker = new Linker(this.items, data.customers);
    this.incoming = [...data.incoming];
  }

  /** Process the mailbox history. `cached` lets a host reuse signals stored from an earlier LLM run. */
  async ingestHistory(cached?: Map<string, { signals: EmailSignals; engine: string }>, provider: AiProvider = heuristicProvider) {
    for (const e of this.data.emails) {
      const hit = cached?.get(e.id);
      await this.processEmail(e, hit ? { signals: hit.signals, engine: hit.engine, latencyMs: 0 } : undefined, provider, false);
    }
    this.scoredCache = null;
  }

  private async processEmail(e: Email, pre: { signals: EmailSignals; engine: string; latencyMs: number } | undefined,
    provider: AiProvider, live: boolean): Promise<ProcessedEmail> {
    const t0 = performance.now();
    const signals = pre?.signals ?? await provider.extract(e, new Date(this.now).toISOString());
    const latencyMs = pre?.latencyMs ?? Math.round(performance.now() - t0);
    // Suspicious emails are never linked, so they cannot move any ticket.
    const link = signals.suspiciousInstructions ? { itemId: null, method: 'none' as const, confidence: 0 } : this.linker.link(e, signals.ticketRefs);
    this.linker.learn(e, link);
    const p: ProcessedEmail = { email: e, link, signals, engine: pre?.engine ?? provider.name, latencyMs };
    this.processed.push(p);
    if (live) {
      this.audit.unshift({ at: e.receivedAt, kind: signals.suspiciousInstructions ? 'injection-blocked' : 'ai-signal', engine: p.engine,
        emailId: e.id, itemId: link.itemId ?? undefined,
        message: signals.suspiciousInstructions
          ? `Email from ${e.from} contained instructions aimed at the AI. Flagged and ignored; no ticket changed.`
          : `${p.engine} read "${e.subject}": ${signals.summary}${link.itemId ? ` (linked by ${link.method}, ${Math.round(link.confidence * 100)}%)` : ''}` });
    }
    return p;
  }

  /** Live demo: the next email lands in the mailbox. Returns the priority changes it caused. */
  async receiveNext(): Promise<{ processed: ProcessedEmail; changes: PriorityChange[] } | null> {
    const e = this.incoming.shift();
    if (!e) return null;
    const before = this.scores();
    this.now = Math.max(this.now, Date.parse(e.receivedAt));
    const p = await this.processEmail(e, undefined, this.ai, true);
    this.scoredCache = null;
    const after = this.scores();
    const changes: PriorityChange[] = [];
    // The linked item and anything blocking it (its urgency propagates to blockers).
    const linkedBlockers = this.items.find(i => i.id === p.link.itemId)?.blockedByIds ?? [];
    for (const [id, s] of after) {
      const b = before.get(id);
      if (!b) continue;
      if (id !== p.link.itemId && !linkedBlockers.includes(id)) continue;
      if (Math.abs(s.score - b.score) >= 8 || s.band !== b.band) {
        // Explain with the factor that moved the most between the two scorings.
        const delta = (k: string) => (s.factors.find(f => f.key === k)?.points ?? 0) - (b.factors.find(f => f.key === k)?.points ?? 0);
        const keys = [...new Set([...s.factors, ...b.factors].map(f => f.key))].sort((x, y) => Math.abs(delta(y)) - Math.abs(delta(x)));
        const main = s.factors.find(f => f.key === keys[0]) ?? (b.factors.find(f => f.key === keys[0]) && { ...b.factors.find(f => f.key === keys[0])!, label: `No longer: ${b.factors.find(f => f.key === keys[0])!.label}` });
        const c: PriorityChange = {
          itemId: id, emailId: e.id, at: e.receivedAt, fromScore: b.score, toScore: s.score, fromBand: b.band, toBand: s.band,
          reason: main ? `${main.label}: ${main.detail}` : p.signals.summary, evidence: p.signals.evidence,
        };
        changes.push(c);
        this.changes.unshift(c);
        this.audit.unshift({ at: e.receivedAt, kind: 'priority-change', itemId: id, emailId: e.id, engine: p.engine,
          message: `${s.item.externalId} moved ${b.band} → ${s.band} (score ${b.score} → ${s.score}). ${c.reason}` });
      }
    }
    return { processed: p, changes };
  }

  setWeights(w: Partial<Weights>) {
    this.weights = { ...this.weights, ...w };
    this.scoredCache = null;
    this.audit.unshift({ at: new Date(this.now).toISOString(), kind: 'weights-changed', message: `Scoring weights changed: ${Object.entries(w).map(([k, v]) => `${k}×${v}`).join(', ')}` });
  }

  /** Manager sets (or clears, with band null) a manual priority. Logged with who and why. */
  setOverride(itemId: string, band: Band | null, reason: string, by = 'Dana Whitfield') {
    const it = this.items.find(i => i.id === itemId);
    if (!it) return;
    const before = this.scores().get(itemId);
    const at = new Date(this.now).toISOString();
    if (band) this.overrides.set(itemId, { itemId, band, reason: reason.trim() || 'No reason given', by, at });
    else this.overrides.delete(itemId);
    this.scoredCache = null;
    const after = this.scores().get(itemId);
    this.audit.unshift({ at, kind: 'manual-override', itemId,
      message: band ? `${by} set ${it.externalId} to ${band} (was ${before?.band ?? '?'}): ${reason.trim() || 'no reason given'}`
        : `${by} removed the manual priority on ${it.externalId}; back to computed ${after?.band ?? '?'}` });
  }

  /** Records an accepted hand-off. In production this would be a suggested change in Siebel/Jira, applied by a human. */
  applyHandoff(itemId: string, toId: string) {
    const it = this.items.find(i => i.id === itemId);
    if (!it) return;
    const from = this.data.people.find(p => p.id === it.assigneeId)!, to = this.data.people.find(p => p.id === toId)!;
    it.assigneeId = toId;
    this.scoredCache = null;
    this.audit.unshift({ at: new Date(this.now).toISOString(), kind: 'handoff-applied', itemId,
      message: `${it.externalId} reassigned ${from.name} → ${to.name} (approved by manager; pending write-back to ${it.source === 'siebel' ? 'Siebel' : 'Jira'})` });
  }

  scores(): Map<string, ScoredItem> {
    if (this.scoredCache) return this.scoredCache;
    const emailsByItem = new Map<string, ProcessedEmail[]>();
    for (const p of this.processed) {
      if (!p.link.itemId || Date.parse(p.email.receivedAt) > this.now) continue;
      emailsByItem.set(p.link.itemId, [...(emailsByItem.get(p.link.itemId) ?? []), p]);
    }
    for (const list of emailsByItem.values()) list.sort((a, b) => a.email.receivedAt.localeCompare(b.email.receivedAt));
    this.scoredCache = scoreAll(this.items, {
      now: this.now, weights: this.weights, customers: this.customers, emailsByItem, items: new Map(this.items.map(i => [i.id, i])),
      overrides: this.overrides,
    });
    return this.scoredCache;
  }

  reminders(scored: ScoredItem[], loads: PersonLoad[]): Reminder[] {
    const out: Reminder[] = [];
    const H = 3600_000;
    const lastMail = new Map<string, ProcessedEmail>();
    for (const p of this.processed) if (p.link.itemId && Date.parse(p.email.receivedAt) <= this.now) lastMail.set(p.link.itemId, p);
    for (const s of scored) {
      const it = s.item;
      const due = Date.parse(it.slaDueAt), created = Date.parse(it.createdAt);
      const left = (due - this.now) / H;
      if (it.status !== 'Waiting on Customer') {
        if (left < 0) out.push({ id: `sla-${it.id}`, personId: it.assigneeId, itemId: it.id, kind: 'sla', severity: 'critical', message: `${it.externalId} breached its SLA ${fmtHours(left)}.` });
        else if ((this.now - created) / (due - created) > 0.75 && left < 24) out.push({ id: `sla-${it.id}`, personId: it.assigneeId, itemId: it.id, kind: 'sla', severity: 'warn', message: `${it.externalId} is past 75% of its SLA window; due ${fmtHours(left)}.` });
      }
      const last = lastMail.get(it.id);
      if (last && !last.email.from.endsWith('northstar-support.example') && Date.parse(last.email.receivedAt) > Date.parse(it.updatedAt)) {
        const ago = (Date.parse(last.email.receivedAt) - this.now) / H;
        if (last.signals.isEscalation) out.push({ id: `esc-${it.id}`, personId: it.assigneeId, itemId: it.id, kind: 'escalation-unacked', severity: 'critical', message: `${last.email.fromName} escalated ${it.externalId} ${fmtHours(ago)} and nobody has responded yet.` });
        else if (ago < -4) out.push({ id: `cw-${it.id}`, personId: it.assigneeId, itemId: it.id, kind: 'customer-waiting', severity: 'warn', message: `${last.email.fromName} replied on ${it.externalId} ${fmtHours(ago)}; no update since.` });
      }
      if (it.severity <= 2 && (this.now - Date.parse(it.updatedAt)) / H > 48 && it.status !== 'Waiting on Customer')
        out.push({ id: `stale-${it.id}`, personId: it.assigneeId, itemId: it.id, kind: 'stale', severity: 'warn', message: `Severity ${it.severity} item ${it.externalId} has not been updated for ${Math.round((this.now - Date.parse(it.updatedAt)) / H / 24)} days.` });
    }
    for (const l of loads.filter(l => l.status === 'overloaded'))
      out.push({ id: `ovl-${l.person.id}`, personId: l.person.id, itemId: l.atRiskItemIds[0] ?? '', kind: 'overload', severity: 'warn',
        message: `${l.person.name} has ${l.queuedHours} h queued (${Math.round(l.loadRatio * 100)}% of remaining capacity); ${l.atRiskItemIds.length} item(s) at risk of missing their due date.` });
    const order = { critical: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  snapshot(): Snapshot {
    const scored = [...this.scores().values()].sort((a, b) => b.score - a.score);
    const loads = computeLoads(this.data.people, scored, this.now);
    const next = this.incoming[0];
    return {
      now: new Date(this.now).toISOString(), teams: this.data.teams, people: this.data.people, customers: this.data.customers,
      items: this.items, scored, loads, handoffs: suggestHandoffs(loads, scored, this.now), reminders: this.reminders(scored, loads),
      processed: this.processed.filter(p => Date.parse(p.email.receivedAt) <= this.now).slice(-400).reverse(),
      changes: this.changes, audit: this.audit.slice(0, 200), weights: this.weights, overrides: [...this.overrides.values()], incomingLeft: this.incoming.length,
      nextIncoming: next ? { fromName: next.fromName, subject: next.subject } : undefined,
    };
  }
}
