// Ticket Q&A. A small set of read-only tools over the engine state. The local LLM calls these
// tools (function calling); without a model, a rule-based router picks the tool from the question.
import type { Snapshot } from './engine.ts';
import type { ScoredItem, WorkItem } from './types.ts';
import { fmtHours } from './scoring.ts';

export interface ChatAnswer {
  text: string;
  refs: string[];        // work item ids the answer cites (rendered as clickable chips)
  engine: string;
  toolCalls: string[];
  latencyMs?: number;
}

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

const H = 3600_000;

export class ChatTools {
  constructor(private s: Snapshot) {}
  private person = (id: string) => this.s.people.find(p => p.id === id)?.name ?? id;
  private customer = (id: string) => this.s.customers.find(c => c.id === id)?.name ?? id;
  private team = (id: string) => this.s.teams.find(t => t.id === id)?.name ?? id;
  private scoredById = () => new Map(this.s.scored.map(x => [x.item.id, x]));

  findItem(ref: string): WorkItem | undefined {
    const r = ref.trim().replace(/^SR\s*/i, '').toUpperCase();
    return this.s.items.find(i => i.externalId.toUpperCase() === r || i.id.toUpperCase() === r);
  }
  matchTeam(q: string) {
    const l = q.toLowerCase();
    return this.s.teams.find(t => l.includes(t.name.toLowerCase()) || t.name.toLowerCase().split(/[ &]+/).some(w => w.length > 3 && l.includes(w)));
  }
  matchPerson(q: string) {
    const l = q.toLowerCase();
    return this.s.people.find(p => l.includes(p.name.toLowerCase()) || l.includes(p.name.split(' ')[0].toLowerCase()));
  }
  matchCustomer(q: string) {
    const l = q.toLowerCase();
    return this.s.customers.find(c => l.includes(c.name.toLowerCase()) || l.includes(c.name.split(' ')[0].toLowerCase()));
  }

  brief(x: ScoredItem | WorkItem) {
    const it = 'item' in x ? x.item : x;
    const sc = 'item' in x ? x : this.scoredById().get(it.id);
    return {
      id: it.externalId, system: it.source === 'siebel' ? 'Siebel' : 'Jira', title: it.title, status: it.status, severity: it.severity,
      priority: sc ? `${sc.band} (score ${sc.score})` : 'resolved', customer: this.customer(it.customerId), assignee: this.person(it.assigneeId),
      team: this.team(it.teamId), slaDue: fmtHours((Date.parse(it.slaDueAt) - Date.parse(this.s.now)) / H),
    };
  }

  /** Tool: search open work items with optional filters. */
  searchItems(f: { text?: string; customer?: string; team?: string; assignee?: string; band?: string; limit?: number }) {
    const l = (s?: string) => s?.toLowerCase().trim();
    let list = this.s.scored;
    if (f.customer) list = list.filter(x => this.customer(x.item.customerId).toLowerCase().includes(l(f.customer)!));
    if (f.team) list = list.filter(x => this.team(x.item.teamId).toLowerCase().includes(l(f.team)!.split(' ')[0]));
    if (f.assignee) list = list.filter(x => this.person(x.item.assigneeId).toLowerCase().includes(l(f.assignee)!.split(' ')[0]));
    if (f.band) list = list.filter(x => x.band === f.band!.toUpperCase());
    if (f.text) {
      const words = l(f.text)!.split(/\W+/).filter(w => w.length > 2);
      list = list.filter(x => words.some(w => `${x.item.title} ${x.item.description}`.toLowerCase().includes(w)));
    }
    return list.slice(0, f.limit ?? 8).map(x => this.brief(x));
  }

  /** Tool: full detail on one item, including why it is ranked where it is and what blocks it. */
  getItem(ref: string) {
    const it = this.findItem(ref);
    if (!it) return { error: `No item ${ref}` };
    const sc = this.scoredById().get(it.id);
    const blockers = it.blockedByIds.map(id => this.s.items.find(i => i.id === id)!).filter(Boolean).map(b => ({ ...this.brief(b), blocks: it.externalId }));
    const linked = it.linkedIds.map(id => this.s.items.find(i => i.id === id)!).filter(Boolean).map(b => this.brief(b));
    const mails = this.s.processed.filter(p => p.link.itemId === it.id).slice(0, 4)
      .map(p => ({ from: p.email.fromName, at: p.email.receivedAt, summary: p.signals.summary, evidence: p.signals.evidence }));
    return { ...this.brief(it), description: it.description, goLive: it.goLiveAt, scoreFactors: sc?.factors.map(f => `${f.points > 0 ? '+' : ''}${f.points} ${f.label}: ${f.detail}`),
      blockedBy: blockers, linkedItems: linked, recentEmails: mails };
  }

  /** Tool: blocker chains for a customer's open work or one ticket. */
  blockers(f: { customer?: string; id?: string }) {
    const c = f.customer ? this.matchCustomer(f.customer) : undefined;
    const items = f.id ? [this.findItem(f.id)].filter((x): x is WorkItem => !!x)
      : this.s.items.filter(i => c && i.customerId === c.id && i.status !== 'Resolved' && (i.blockedByIds.length || i.goLiveAt || i.status === 'Blocked'));
    return items.map(it => {
      const blockedBy = it.blockedByIds.map(id => this.s.items.find(i => i.id === id)).filter((x): x is WorkItem => !!x).map(b => {
        const load = this.s.loads.find(l => l.person.id === b.assigneeId);
        return { ...this.brief(b), ownerLoad: load ? `${load.status}, ${Math.round(load.loadRatio * 100)}% of capacity` : undefined };
      });
      return { ...this.brief(it), goLive: it.goLiveAt, blockedBy, linked: it.linkedIds.map(id => this.s.items.find(i => i.id === id)?.externalId) };
    });
  }

  /** Tool: workload per person, optionally for one team, with suggested hand-offs. */
  workload(team?: string) {
    const t = team ? this.matchTeam(team) : undefined;
    const loads = this.s.loads.filter(l => !t || l.person.teamId === t.id);
    return {
      people: loads.map(l => ({ name: l.person.name, team: this.team(l.person.teamId), queuedHours: l.queuedHours, loadPct: Math.round(l.loadRatio * 100), status: l.status, atRisk: l.atRiskItemIds.length })),
      suggestedHandoffs: this.s.handoffs.filter(h => loads.some(l => l.person.id === h.fromId))
        .map(h => ({ item: this.s.items.find(i => i.id === h.itemId)!.externalId, from: this.person(h.fromId), to: this.person(h.toId), reason: h.reason })),
    };
  }

  /** Tool: priority changes detected from email, newest first. */
  recentChanges(limit = 6) {
    return this.s.changes.slice(0, limit).map(c => ({ item: this.s.items.find(i => i.id === c.itemId)!.externalId, from: c.fromBand, to: c.toBand, reason: c.reason, at: c.at }));
  }

  /** Tool: items breaching SLA within N hours. */
  slaRisk(hours = 24) {
    const now = Date.parse(this.s.now);
    return this.s.scored.filter(x => x.item.status !== 'Waiting on Customer' && Date.parse(x.item.slaDueAt) - now < hours * H)
      .sort((a, b) => a.item.slaDueAt.localeCompare(b.item.slaDueAt)).slice(0, 10).map(x => this.brief(x));
  }

  refsIn(text: string): string[] {
    const ids = new Set<string>();
    for (const it of this.s.items) if (text.includes(it.externalId)) ids.add(it.id);
    return [...ids];
  }
}

const line = (b: ReturnType<ChatTools['brief']>) => `• ${b.id} (${b.system}) ${b.title}: ${b.priority}, ${b.status}, ${b.assignee}, SLA ${b.slaDue}`;

/** Rule-based router used when no local model is loaded. */
export function answerWithoutModel(question: string, s: Snapshot): ChatAnswer {
  const t = new ChatTools(s);
  const q = question.toLowerCase();
  const calls: string[] = [];
  const done = (text: string, extraRefs: string[] = []): ChatAnswer => ({ text, refs: [...new Set([...t.refsIn(text), ...extraRefs])], engine: 'Rule engine', toolCalls: calls });
  const ref = question.match(/\b(1-[A-Z0-9]{6}|[A-Z]{2,6}-\d{2,6})\b/i)?.[1];
  const customer = t.matchCustomer(q);
  const team = t.matchTeam(q);
  const person = t.matchPerson(q);

  if (/(block|stuck|waiting for|holding up|go-live|golive)/.test(q) && (customer || ref)) {
    calls.push(`blockers(${customer?.name ?? ref})`);
    const r = t.blockers({ customer: customer?.name, id: ref });
    if (!r.length) return done(`I found no blocked open items for ${customer?.name ?? ref}.`);
    const parts = r.map(it => `${it.id} "${it.title}" is ${it.status}, ${it.priority}, owned by ${it.assignee}: `
      + (it.blockedBy.length ? it.blockedBy.map(b => `blocked by ${b.id} "${b.title}" (${b.assignee}, ${b.status}${b.ownerLoad ? `; ${b.assignee.split(' ')[0]} is ${b.ownerLoad}` : ''})`).join('; ')
        : it.goLive ? 'on the go-live path, no technical blocker recorded' : 'no recorded blocker') + '.');
    return done(parts.join('\n'));
  }
  if (/(overload|too much|capacity|workload|busy|rebalanc|hand.?off)/.test(q)) {
    calls.push(`workload(${team?.name ?? ''})`);
    const w = t.workload(team?.name);
    const over = w.people.filter(p => p.status !== 'ok').sort((a, b) => b.loadPct - a.loadPct);
    const text = (over.length ? `${over.filter(p => p.status === 'overloaded').length} overloaded, ${over.filter(p => p.status === 'busy').length} busy${team ? ` in ${team.name}` : ''}:\n` + over.slice(0, 6).map(p => `• ${p.name} (${p.team}): ${p.queuedHours} h queued, ${p.loadPct}% of capacity, ${p.atRisk} at risk`).join('\n') : 'Nobody is overloaded right now.')
      + (w.suggestedHandoffs.length ? `\n\nSuggested hand-offs:\n` + w.suggestedHandoffs.map(h => `• ${h.item}: ${h.from} → ${h.to}`).join('\n') : '');
    return done(text);
  }
  if (/(chang|moved|jump|escalat|what happened|new today|since)/.test(q)) {
    calls.push('recentChanges()');
    const c = t.recentChanges(6);
    if (!c.length) return done('No priority changes detected from email yet. Press "Next email" to let new mail arrive.');
    return done('Latest priority changes picked up from email:\n' + c.map(x => `• ${x.item}: ${x.from} → ${x.to}. ${x.reason}`).join('\n'));
  }
  if (/(sla|breach|overdue|due soon)/.test(q)) {
    calls.push('slaRisk(24)');
    const r = t.slaRisk(24).filter(b => !team || b.team === team.name);
    return done(`${r.length} items breach or are due within 24 h:\n` + r.slice(0, 8).map(line).join('\n'));
  }
  if (ref) {
    calls.push(`getItem(${ref})`);
    const d = t.getItem(ref);
    if ('error' in d) return done(d.error!);
    return done(`${d.id} (${d.system}) "${d.title}"\n${d.status}, ${d.priority}, ${d.customer}, owned by ${d.assignee}, SLA ${d.slaDue}.\n\nWhy it ranks here:\n${(d.scoreFactors ?? []).slice(0, 5).map(f => `• ${f}`).join('\n')}`
      + (d.recentEmails.length ? `\n\nLatest email: ${d.recentEmails[0].from}: "${d.recentEmails[0].evidence || d.recentEmails[0].summary}"` : ''));
  }
  if (person || team || customer || /(top|urgent|priorit|focus|first|important|next)/.test(q)) {
    const f = { customer: customer?.name, team: person ? undefined : team?.name, assignee: person?.name, limit: 5 };
    calls.push(`searchItems(${JSON.stringify(f)})`);
    const r = t.searchItems(f);
    const who = person?.name ?? customer?.name ?? team?.name ?? 'all teams';
    return done(r.length ? `Top ${r.length} open items for ${who}, by priority:\n${r.map(line).join('\n')}` : `No open items for ${who}.`);
  }
  calls.push(`searchItems({text: "${question}"})`);
  const r = t.searchItems({ text: question, limit: 5 });
  return done(r.length ? `Closest matches:\n${r.map(line).join('\n')}` : `I could not find anything for that. Try a ticket id, a customer, a team or a person.`);
}
