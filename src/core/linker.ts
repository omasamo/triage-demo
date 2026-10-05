// Links an email to a work item: ticket ids first, then the email thread, then customer + keywords.
import type { Customer, Email, LinkResult, WorkItem } from './types.ts';

const SIEBEL_RE = /\b(?:SR\s*#?\s*)?(1-[A-Z0-9]{6})\b/g;
const JIRA_RE = /\b([A-Z]{2,6}-\d{2,6})\b/g;
const STOP = new Set('the a an and or of to for in on at is are be we our your you it this that with from please can could will not no as by have has hi hello thanks regards best'.split(' '));

export function findTicketRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SIEBEL_RE)) out.add(m[1]);
  for (const m of text.matchAll(JIRA_RE)) if (!m[1].startsWith('EUR-')) out.add(m[1]);
  return [...out];
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

export class Linker {
  private byExternal = new Map<string, WorkItem>();
  private threadToItem = new Map<string, string>();
  private byDomain = new Map<string, Customer>();

  constructor(private items: WorkItem[], customers: Customer[]) {
    for (const it of items) this.byExternal.set(it.externalId, it);
    for (const c of customers) this.byDomain.set(c.domain, c);
  }

  /** Remember thread membership so later replies without an id still link. */
  learn(email: Email, link: LinkResult) {
    if (link.itemId && link.confidence >= 0.6) this.threadToItem.set(email.threadId, link.itemId);
  }

  customerFor(email: Email): Customer | undefined {
    return this.byDomain.get(email.from.split('@')[1] ?? '');
  }

  link(email: Email, refsFromAi: string[] = []): LinkResult {
    const text = `${email.subject}\n${email.body}`;
    const refs = [...new Set([...findTicketRefs(text), ...refsFromAi])];
    const hits = refs.map(r => this.byExternal.get(r)).filter((x): x is WorkItem => !!x);
    if (hits.length) {
      // Prefer the ticket in the subject, then the first mention in the body.
      const inSubject = hits.find(h => email.subject.includes(h.externalId));
      return { itemId: (inSubject ?? hits[0]).id, method: 'ticket-id', confidence: 0.98 };
    }
    const viaThread = this.threadToItem.get(email.threadId);
    if (viaThread) return { itemId: viaThread, method: 'thread', confidence: 0.9 };

    const customer = this.customerFor(email);
    if (!customer) return { itemId: null, method: 'none', confidence: 0 };
    const words = new Set(tokens(text));
    let best: WorkItem | null = null, bestScore = 0;
    for (const it of this.items) {
      if (it.customerId !== customer.id || it.status === 'Resolved') continue;
      const t = tokens(`${it.title} ${it.description}`);
      const overlap = t.filter(w => words.has(w)).length / Math.max(4, new Set(t).size);
      if (overlap > bestScore) { bestScore = overlap; best = it; }
    }
    if (best && bestScore >= 0.25) return { itemId: best.id, method: 'customer+keywords', confidence: Math.min(0.85, 0.4 + bestScore) };
    return { itemId: null, method: 'none', confidence: 0 };
  }
}
