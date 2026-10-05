// Tool-first chat for small models: the model only chooses one read-only query (constrained JSON),
// the app runs it and writes the facts itself, and the model adds a one- or two-sentence answer on
// top that is checked against those facts (see answerWithModel in ../chat.ts).
import type { Snapshot } from '../engine.ts';
import type { ChatTools } from '../chat.ts';

export const TOOLS = ['searchItems', 'getItem', 'blockers', 'workload', 'recentChanges', 'slaRisk'] as const;

export const TOOL_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    tool: { enum: TOOLS },
    args: {
      type: 'object',
      properties: {
        id: { type: 'string' }, text: { type: 'string' }, customer: { type: 'string' },
        team: { type: 'string' }, assignee: { type: 'string' }, band: { enum: ['', 'P1', 'P2', 'P3', 'P4'] },
      },
      required: ['id', 'text', 'customer', 'team', 'assignee', 'band'],
    },
  },
  required: ['tool', 'args'],
} as const;

export interface ToolQuery {
  tool: typeof TOOLS[number];
  args?: { id?: string; text?: string; customer?: string; team?: string; assignee?: string; band?: string };
}

export function toolPickerPrompt(s: Snapshot) {
  return `You route questions in a support triage tool to ONE data query. Reply with JSON only. Use "" for unused args.
Tools:
- searchItems: open tickets ranked by priority; filter by customer, team, assignee, band (P1-P4) or text.
- getItem: everything about one ticket; args.id is the ticket id from the question (Siebel 1-XXXXXX or Jira PROJECT-123).
- blockers: what blocks a customer's work or a ticket; args.customer or args.id.
- workload: who is overloaded and suggested hand-offs; optional args.team.
- recentChanges: priority changes detected from email today.
- slaRisk: tickets breaching or due within 24 hours.
Customers: ${s.customers.map(c => c.name).join(', ')}.
Teams: ${s.teams.map(t => t.name).join(', ')}.
People: ${s.people.filter(p => p.role !== 'Manager').map(p => p.name).join(', ')}.
Only fill customer, team, assignee or id when the question names them.
Examples:
"What is blocking the Acme go-live?" -> {"tool":"blockers","args":{"id":"","text":"","customer":"Acme Logistics","team":"","assignee":"","band":""}}
"Who is overloaded right now?" -> {"tool":"workload","args":{"id":"","text":"","customer":"","team":"","assignee":"","band":""}}
"Is anyone in Platform Ops overloaded?" -> {"tool":"workload","args":{"id":"","text":"","customer":"","team":"Platform Ops","assignee":"","band":""}}
"What should Marek work on first?" -> {"tool":"searchItems","args":{"id":"","text":"","customer":"","team":"","assignee":"Marek Horvath","band":""}}`;
}

export function leadPrompt(s: Snapshot) {
  return `You are the assistant in a support triage tool. It is ${s.now}. The app has looked up the facts below and shows them under your answer.
Write ONE or TWO short sentences that answer the manager's question from these facts: the conclusion first, then the most important reason.
Use only names, ticket ids and numbers that appear in the facts, copied exactly. Do not list every item. Plain text, no markdown.`;
}

export function runToolQuery(t: ChatTools, q: ToolQuery): unknown {
  const a = Object.fromEntries(Object.entries(q.args ?? {}).filter(([, v]) => v)) as NonNullable<ToolQuery['args']>;
  switch (q.tool) {
    case 'getItem': return a.id ? t.getItem(a.id) : t.searchItems({ ...a, limit: 5 });
    case 'blockers': return t.blockers({ customer: a.customer, id: a.id });
    case 'workload': return t.workload(a.team);
    case 'recentChanges': return t.recentChanges();
    case 'slaRisk': return t.slaRisk(24, a.team);
    default: return t.searchItems({ ...a, limit: 8 });
  }
}
