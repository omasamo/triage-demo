// Ticket Q&A. A small set of read-only tools over the engine state. A model (local or team hub)
// understands the question and picks the tool; without one, a rule-based router does. Either way the
// app runs the tool and writes the answer itself, so every ticket id, owner and number comes from the
// data. (Benchmarks showed a 2B model's own sentences sometimes contradicted the list under them.)
import type { Snapshot } from './engine.ts';
import type { ScoredItem, WorkItem } from './types.ts';
import { fmtHours } from './scoring.ts';
import { TOOLS, runToolQuery, toolPickerPrompt, type ToolQuery } from './ai/chatPlan.ts';
import { parseModelJson } from './ai/json.ts';

export interface ChatAnswer {
  text: string;
  refs: string[];        // work item ids the answer cites (rendered as clickable chips)
  engine: string;
  toolCalls: string[];
  latencyMs?: number;
}

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

const H = 3600_000;
const GENERIC = new Set(['customer', 'team', 'support']);
const STOP = new Set(['anything', 'about', 'what', 'which', 'there', 'show', 'tell', 'with', 'the', 'for', 'are', 'any', 'from', 'have', 'this', 'that', 'ticket', 'tickets', 'issue', 'issues', 'open', 'items', 'all']);
const ID_RE = /\b(1-[A-Z0-9]{6}|[A-Z]{2,6}-\d{2,6})\b/gi;
const ID_EXACT = /\b(1-[A-Z0-9]{6}|[A-Z]{2,6}-\d{2,6})\b/g;

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
  /** Whole-word mention of a person (full or first name), customer (full or first word) or team (name or a distinctive word). */
  mentions(text: string, name: string, kind: 'person' | 'customer' | 'team') {
    const words = kind === 'team' ? name.split(/[ &]+/).filter(w => w.length > 3 && !GENERIC.has(w.toLowerCase())) : [name.split(' ')[0]];
    return [name, ...words].some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  }
  matchTeam(q: string) { return this.s.teams.find(t => this.mentions(q, t.name, 'team')); }
  matchPerson(q: string) { return this.s.people.find(p => p.role !== 'Manager' && this.mentions(q, p.name, 'person')); }
  matchCustomer(q: string) { return this.s.customers.find(c => this.mentions(q, c.name, 'customer')); }
  people() { return this.s.people.filter(p => p.role !== 'Manager'); }
  customers() { return this.s.customers; }

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
      const words = l(f.text)!.split(/\W+/).filter(w => w.length > 2 && !STOP.has(w));
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
        return { ...this.brief(b), ownerLoad: load ? `${load.status}, ${Math.round(load.loadRatio * 100)}% of capacity` : undefined,
          ownerOverloaded: load?.status === 'overloaded', ownerLoadPct: load ? Math.round(load.loadRatio * 100) : undefined };
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

  /** Tool: items breaching SLA within N hours, optionally for one team (the ten most urgent, plus totals). */
  slaRisk(hours = 24, team?: string) {
    const now = Date.parse(this.s.now);
    const t = team ? this.matchTeam(team) : undefined;
    const due = this.s.scored.filter(x => x.item.status !== 'Waiting on Customer' && Date.parse(x.item.slaDueAt) - now < hours * H && (!t || x.item.teamId === t.id))
      .sort((a, b) => a.item.slaDueAt.localeCompare(b.item.slaDueAt));
    return { total: due.length, breached: due.filter(x => Date.parse(x.item.slaDueAt) < now).length, items: due.slice(0, 10).map(x => this.brief(x)) };
  }

  refsIn(text: string): string[] {
    const ids = new Set<string>();
    for (const it of this.s.items) if (text.includes(it.externalId)) ids.add(it.id);
    return [...ids];
  }
}

const line = (b: ReturnType<ChatTools['brief']>) => `• ${b.id} (${b.system}) ${b.title}: ${b.priority}, ${b.status}, ${b.assignee}, SLA ${b.slaDue}`;
const EMPTY_ARGS = { id: '', text: '', customer: '', team: '', assignee: '', band: '' };
const callLabel = (q: ToolQuery) => `${q.tool}(${JSON.stringify(Object.fromEntries(Object.entries(q.args ?? {}).filter(([, v]) => v)))})`;

/** Rule-based router used when no model is loaded (and when a model's choice cannot be parsed). */
export function routeQuestion(question: string, t: ChatTools): ToolQuery {
  const q = question.toLowerCase();
  const id = question.match(ID_RE)?.[0] ?? '';
  const customer = t.matchCustomer(question)?.name ?? '';
  const team = t.matchTeam(question)?.name ?? '';
  const assignee = t.matchPerson(question)?.name ?? '';
  const band = question.match(/\bP[1-4]\b/i)?.[0].toUpperCase() ?? '';
  const a = EMPTY_ARGS;
  if (/(block|stuck|waiting for|holding up|go-live|golive)/.test(q) && (customer || id)) return { tool: 'blockers', args: { ...a, customer, id } };
  if (/(overload|too much|capacity|workload|busy|rebalanc|hand.?off)/.test(q)) return { tool: 'workload', args: { ...a, team } };
  if (/(chang|moved|jump|escalat|what happened|new today|since)/.test(q)) return { tool: 'recentChanges', args: a };
  if (/(sla|breach|overdue|due soon)/.test(q)) return { tool: 'slaRisk', args: { ...a, team } };
  if (id) return { tool: 'getItem', args: { ...a, id } };
  if (assignee || team || customer || band || /(top|urgent|priorit|focus|first|important|next)/.test(q))
    return { tool: 'searchItems', args: { ...a, customer, team: assignee ? '' : team, assignee, band } };
  return { tool: 'searchItems', args: { ...a, text: question } };
}

/** Keeps only the arguments the question (or the last two turns) actually names, and fills in the ones it
 *  names that the model left out. A small model cannot narrow a query to a team nobody asked about. */
export function groundQuery(t: ChatTools, q: ToolQuery, question: string, history: ChatTurn[] = []): ToolQuery {
  const recent = history.slice(-2).map(h => h.text).join('\n');
  const pick = (v: string | undefined, kind: 'person' | 'customer' | 'team', match: (s: string) => { name: string } | undefined) => {
    const meant = v ? match(v) : undefined;
    if (meant && (t.mentions(question, meant.name, kind) || t.mentions(recent, meant.name, kind))) return meant.name;
    return match(question)?.name ?? '';
  };
  const a = q.args ?? {};
  const ids = [...question.matchAll(ID_RE), ...recent.matchAll(ID_RE)].map(m => m[0].toUpperCase());
  const assignee = pick(a.assignee, 'person', s => t.matchPerson(s));
  const args = {
    id: a.id && ids.includes(a.id.toUpperCase()) ? a.id : question.match(ID_RE)?.[0] ?? '',
    customer: pick(a.customer, 'customer', s => t.matchCustomer(s)),
    team: assignee ? '' : pick(a.team, 'team', s => t.matchTeam(s)),
    assignee,
    band: question.match(/\bP[1-4]\b/i)?.[0].toUpperCase() ?? '',
    text: '',
  };
  if (q.tool === 'searchItems' && !args.customer && !args.team && !args.assignee && !args.band && !/(top|urgent|priorit|focus|first|important|next)/i.test(question))
    args.text = a.text || question;
  return { tool: TOOLS.includes(q.tool) ? q.tool : 'searchItems', args };
}

/** The answer: a one-sentence conclusion computed from the data, then the facts behind it. */
export function renderResult(t: ChatTools, q: ToolQuery, result: unknown): string {
  const c = conclusion(q, result);
  const f = facts(t, q, result);
  return [c, f].filter(Boolean).join('\n\n');
}

function conclusion(q: ToolQuery, result: unknown): string {
  const a = { ...EMPTY_ARGS, ...q.args };
  const and = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  switch (q.tool) {
    case 'blockers': {
      const r = result as ReturnType<ChatTools['blockers']>;
      const it = r.find(x => x.blockedBy.length);
      if (!r.length) return '';
      if (!it) return `No technical blocker is recorded for ${a.customer || a.id}.`;
      const b = it.blockedBy[0];
      const what = it.goLive && a.customer ? `The ${a.customer} go-live` : it.id;
      return `${what} is held up by ${b.id} (${b.title}), which blocks ${it.id}. ${b.assignee} owns it`
        + (b.ownerOverloaded ? ` and is overloaded at ${b.ownerLoadPct}% of capacity.` : '.');
    }
    case 'workload': {
      const w = result as ReturnType<ChatTools['workload']>;
      const over = w.people.filter(p => p.status === 'overloaded').sort((x, y) => y.loadPct - x.loadPct);
      if (!over.length) return '';
      return `${and(over.map(p => `${p.name} (${p.loadPct}%)`))} ${over.length === 1 ? 'is' : 'are'} overloaded`
        + (w.suggestedHandoffs.length ? `; ${w.suggestedHandoffs.length} hand-off${w.suggestedHandoffs.length === 1 ? ' is' : 's are'} suggested.` : '.');
    }
    case 'recentChanges': {
      const c = result as ReturnType<ChatTools['recentChanges']>;
      return c.length ? `The latest change from email moved ${c[0].item} from ${c[0].from} to ${c[0].to}.` : '';
    }
    case 'slaRisk': {
      const r = result as ReturnType<ChatTools['slaRisk']>;
      if (!r.total) return `Nothing${a.team ? ` in ${a.team}` : ''} breaches or is due within 24 h.`;
      const first = r.items[0];
      return `${r.total} item${r.total === 1 ? '' : 's'}${a.team ? ` in ${a.team}` : ''} breach or are due within 24 h${r.breached ? `, ${r.breached} already breached` : ''}. `
        + `The ${r.breached ? 'most overdue' : 'first due'} is ${first.id} (${first.priority.split(' ')[0]}, SLA ${first.slaDue}).`;
    }
    case 'getItem': {
      if (Array.isArray(result) || 'error' in (result as object)) break;
      const d = result as Exclude<ReturnType<ChatTools['getItem']>, { error: string }>;
      const f = d.scoreFactors?.[0]?.match(/^([+-]?\d+) ([^:]+)/);
      return f ? `${d.id} is ${d.priority}. Biggest factor: ${f[2]} (${f[1]} points).` : '';
    }
  }
  const r = result as ReturnType<ChatTools['searchItems']>;
  if (!Array.isArray(r) || !r.length) return '';
  const top = r[0];
  if (a.assignee) return `${a.assignee.split(' ')[0]} should start with ${top.id}, ${top.title} (${top.priority.split(' ')[0]}, SLA ${top.slaDue}).`;
  if (a.customer || a.team) return `The most urgent open item for ${a.customer || a.team} is ${top.id}, ${top.title} (${top.priority.split(' ')[0]}).`;
  if (a.band) return `The most urgent open ${a.band} item is ${top.id}, ${top.title}.`;
  return '';
}

/** The facts for a tool result: the list or detail the conclusion is drawn from. */
function facts(t: ChatTools, q: ToolQuery, result: unknown): string {
  const a = { ...EMPTY_ARGS, ...q.args };
  switch (q.tool) {
    case 'blockers': {
      const r = result as ReturnType<ChatTools['blockers']>;
      if (!r.length) return `I found no blocked open items for ${a.customer || a.id || 'that question'}.`;
      return r.map(it => `${it.id} "${it.title}" is ${it.status}, ${it.priority}, owned by ${it.assignee}: `
        + (it.blockedBy.length ? it.blockedBy.map(b => `blocked by ${b.id} "${b.title}" (${b.assignee}, ${b.status}${b.ownerLoad ? `; ${b.assignee.split(' ')[0]} is ${b.ownerLoad}` : ''})`).join('; ')
          : it.goLive ? 'on the go-live path, no technical blocker recorded' : 'no recorded blocker') + '.').join('\n');
    }
    case 'workload': {
      const w = result as ReturnType<ChatTools['workload']>;
      const over = w.people.filter(p => p.status !== 'ok').sort((x, y) => y.loadPct - x.loadPct);
      return (over.length ? `${over.filter(p => p.status === 'overloaded').length} overloaded, ${over.filter(p => p.status === 'busy').length} busy${a.team ? ` in ${a.team}` : ''}:\n`
        + over.slice(0, 6).map(p => `• ${p.name} (${p.team}): ${p.queuedHours} h queued, ${p.loadPct}% of capacity, ${p.atRisk} at risk`).join('\n') : `Nobody is overloaded${a.team ? ` in ${a.team}` : ''} right now.`)
        + (w.suggestedHandoffs.length ? `\n\nSuggested hand-offs:\n` + w.suggestedHandoffs.map(h => `• ${h.item}: ${h.from} → ${h.to}`).join('\n') : '');
    }
    case 'recentChanges': {
      const c = result as ReturnType<ChatTools['recentChanges']>;
      if (!c.length) return 'No priority changes detected from email yet. Press "Next email" to let new mail arrive.';
      return 'Latest priority changes picked up from email:\n' + c.map(x => `• ${x.item}: ${x.from} → ${x.to}. ${x.reason}`).join('\n');
    }
    case 'slaRisk': {
      const r = result as ReturnType<ChatTools['slaRisk']>;
      return r.total ? `By due time${r.total > 8 ? ' (first 8)' : ''}:\n` + r.items.slice(0, 8).map(line).join('\n') : '';
    }
    case 'getItem': {
      if (Array.isArray(result)) break;
      const d = result as ReturnType<ChatTools['getItem']>;
      if ('error' in d) return d.error!;
      return `${d.id} (${d.system}) "${d.title}"\n${d.status}, ${d.priority}, ${d.customer}, owned by ${d.assignee}, SLA ${d.slaDue}.\n\nWhy it ranks here:\n${(d.scoreFactors ?? []).slice(0, 5).map(f => `• ${f}`).join('\n')}`
        + (d.recentEmails.length ? `\n\nLatest email: ${d.recentEmails[0].from}: "${d.recentEmails[0].evidence || d.recentEmails[0].summary}"` : '');
    }
  }
  const r = (result as ReturnType<ChatTools['searchItems']>).slice(0, 5);
  if (a.band && !a.assignee && !a.customer && !a.team) return r.length ? `Top ${r.length} open ${a.band} items:\n${r.map(line).join('\n')}` : `No open ${a.band} items.`;
  const who = a.assignee || a.customer || a.team;
  if (!who && a.text) return r.length ? `Closest matches:\n${r.map(line).join('\n')}` : 'I could not find anything for that. Try a ticket id, a customer, a team or a person.';
  return r.length ? `Top ${r.length} open items for ${who || 'all teams'}, by priority:\n${r.map(line).join('\n')}` : `No open items for ${who || 'that question'}.`;
}

/** What a chat model provides: understanding the question. LocalModels and ServerModels implement it. */
export interface ChatModel {
  name: string;
  pickTool(system: string, user: string): Promise<string>;
}

export async function answerWithModel(question: string, history: ChatTurn[], s: Snapshot, m: ChatModel): Promise<ChatAnswer> {
  const t0 = performance.now();
  const t = new ChatTools(s);
  const ctx = history.slice(-4).map(h => `${h.role}: ${h.text}`).join('\n');
  let q: ToolQuery, engine = m.name;
  try {
    const raw = await m.pickTool(toolPickerPrompt(s), ctx ? `Conversation so far:\n${ctx}\n\nNew question: ${question}` : question);
    q = groundQuery(t, parseModelJson<ToolQuery>(raw), question, history);
  } catch { q = routeQuestion(question, t); engine = `Rule engine (fallback from ${m.name})`; }
  const text = renderResult(t, q, runToolQuery(t, q));
  return { text, refs: t.refsIn(text).slice(0, 12), engine, toolCalls: [callLabel(q)], latencyMs: Math.round(performance.now() - t0) };
}

export function answerWithoutModel(question: string, s: Snapshot): ChatAnswer {
  const t = new ChatTools(s);
  const q = routeQuestion(question, t);
  const text = renderResult(t, q, runToolQuery(t, q));
  return { text, refs: t.refsIn(text), engine: 'Rule engine', toolCalls: [callLabel(q)] };
}
