import type { KeyboardEvent } from 'react';
import { Sparkles } from 'lucide-react';
import type { Snapshot } from '../../core/engine.ts';
import type { ScoredItem, ScoreFactor } from '../../core/types.ts';
import { Tag, rel } from './ui.tsx';

/** Short, scannable names for the factors that explain a rank. Severity alone says little, so it only counts at S1. */
function short(f: ScoreFactor, x: ScoredItem): string | null {
  switch (f.key) {
    case 'escalation': return 'Escalated';
    case 'executive': return 'Exec involved';
    case 'deadline': return 'Deadline';
    case 'sentiment': return 'Upset customer';
    case 'deescalation': return 'Calmed down';
    case 'sla': return f.detail.startsWith('SLA breached') ? 'SLA breached' : 'SLA soon';
    case 'tier': return f.detail.replace(/^.* is an? /, '');
    case 'goLive': return 'Go-live soon';
    case 'stale': return 'No recent update';
    case 'blocking': return 'Blocks others';
    case 'override': return 'Manager set';
    case 'severity': return x.item.severity === 1 ? 'Severity 1' : null;
    default: return null;
  }
}

const AI = new Set(['escalation', 'executive', 'deadline', 'sentiment', 'deescalation']);

/** The two factors that most explain this item's rank, as tags: purple for what the AI read in email. */
export function WhyTags({ x, max = 2 }: { x: ScoredItem; max?: number }) {
  const top = x.factors
    .filter(f => f.points > 0 || f.key === 'deescalation')
    .map(f => ({ f, label: short(f, x) }))
    .filter((t): t is { f: ScoreFactor; label: string } => !!t.label)
    .sort((a, b) => Math.abs(b.f.points) - Math.abs(a.f.points))
    .slice(0, max);
  return (
    <span className="why">
      {top.map(({ f, label }) => (
        <Tag key={f.key} title={`${f.points > 0 ? '+' : ''}${f.points} ${f.detail}`}
          color={f.key === 'deescalation' ? 'green' : f.key === 'override' ? 'blue' : AI.has(f.key) ? 'purple' : f.key === 'sla' && label === 'SLA breached' ? 'red' : undefined}>
          {AI.has(f.key) && <Sparkles size={10} />}{label}
        </Tag>
      ))}
    </span>
  );
}

export interface NextStep {
  kind: 'handoff' | 'blocked' | 'reply' | 'breach' | 'deadline' | 'none';
  text: string;
  /** What the button does: open another item, an email, or the workload page. */
  target?: { itemId?: string; emailId?: string; workload?: boolean };
  cta?: string;
}

/** The one thing a manager should do about an item, worked out from data the app already has. */
export function nextStep(s: Snapshot, x: ScoredItem): NextStep {
  const it = x.item;
  const name = (id: string) => s.people.find(p => p.id === id)?.name ?? 'someone';
  const owner = name(it.assigneeId);
  const handoff = s.handoffs.find(h => h.itemId === it.id);
  if (handoff) return { kind: 'handoff', text: `Hand it to ${name(handoff.toId)}: ${owner.split(' ')[0]}'s queue would make it miss its date.`, target: { workload: true }, cta: 'Review hand-off' };
  const blocker = it.blockedByIds.map(id => s.items.find(i => i.id === id)).find(b => b && b.status !== 'Resolved');
  if (blocker) return { kind: 'blocked', text: `Unblock it first: ${blocker.externalId} (${name(blocker.assigneeId)}) is holding it up.`, target: { itemId: blocker.id }, cta: `Open ${blocker.externalId}` };
  const esc = x.factors.find(f => f.key === 'escalation');
  const unacked = s.reminders.find(r => r.itemId === it.id && r.kind === 'escalation-unacked');
  if (esc && unacked) {
    const mail = s.processed.find(p => p.email.id === esc.emailId);
    return { kind: 'reply', text: `Make sure ${owner.split(' ')[0]} answers ${mail?.email.fromName ?? 'the customer'}: escalated ${mail ? rel(mail.email.receivedAt, s.now) : ''} with no reply yet.`, target: { emailId: esc.emailId }, cta: 'Read the email' };
  }
  const due = Date.parse(it.slaDueAt) - Date.parse(s.now);
  if (due < 0 && it.status !== 'Waiting on Customer') return { kind: 'breach', text: `SLA breached ${rel(it.slaDueAt, s.now).replace(' ago', '')} ago: ask ${owner.split(' ')[0]} for an update or reset the customer's expectation.` };
  const dl = x.factors.find(f => f.key === 'deadline');
  if (dl?.at) return { kind: 'deadline', text: `Customer deadline ${rel(dl.at, s.now)}: confirm ${owner.split(' ')[0]} has a plan to meet it.`, target: dl.emailId ? { emailId: dl.emailId } : undefined, cta: dl.emailId ? 'Read the email' : undefined };
  return { kind: 'none', text: `${owner} has it (${it.status.toLowerCase()}). Nothing needed from you right now.` };
}

/** Makes a non-button element (table row, feed item) reachable and usable from the keyboard. */
export function pressable(onPress: () => void, asButton = true) {
  return {
    // Table rows keep their row role so screen readers still read them as a table.
    role: asButton ? 'button' as const : undefined,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); } },
  };
}
