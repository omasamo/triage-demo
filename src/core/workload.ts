// Workload model: each person works their queue in score order at ~6 productive hours per day.
// Items projected to finish after their SLA or deadline are "at risk because of load",
// which is what drives hand-off suggestions.
import type { Handoff, Person, PersonLoad, ScoredItem, WorkItem } from './types.ts';
import { fmtHours } from './scoring.ts';

const HOUR = 3600_000;
const PRODUCTIVE_PER_DAY = 6;

const queued = (s: ScoredItem) => s.item.status !== 'Waiting on Customer' && s.item.status !== 'Resolved';

/** Effective due time: SLA or an email deadline, whichever is earlier. */
export function dueAt(s: ScoredItem): number {
  const f = s.factors.find(f => f.key === 'deadline' && f.at);
  return Math.min(Date.parse(s.item.slaDueAt), f ? Date.parse(f.at!) : Infinity);
}

function projectQueue(queue: ScoredItem[], now: number) {
  let cum = 0;
  return queue.map(s => {
    cum += s.item.effortHours;
    return { s, finish: now + (cum / PRODUCTIVE_PER_DAY) * 24 * HOUR };
  });
}

export function computeLoads(people: Person[], scored: ScoredItem[], now: number): PersonLoad[] {
  const weekFractionLeft = Math.max(0.2, (5 - ((new Date(now).getUTCDay() + 6) % 7)) / 5);
  return people.filter(p => p.role !== 'Manager').map(person => {
    const mine = scored.filter(s => s.item.assigneeId === person.id && queued(s)).sort((a, b) => b.score - a.score);
    const hours = mine.reduce((h, s) => h + s.item.effortHours, 0);
    const capacity = person.capacityHoursPerWeek * weekFractionLeft;
    const projected = projectQueue(mine, now);
    const atRisk = projected.filter(({ s, finish }) => dueAt(s) > now && finish > dueAt(s)).map(x => x.s.item.id);
    const ratio = capacity ? hours / capacity : 0;
    return {
      person, openItems: mine.length, queuedHours: Math.round(hours * 10) / 10, capacityHours: Math.round(capacity), loadRatio: Math.round(ratio * 100) / 100,
      atRiskItemIds: atRisk, status: ratio > 1.2 ? 'overloaded' : ratio > 0.9 || atRisk.length >= 2 ? 'busy' : 'ok',
    };
  });
}

export function suggestHandoffs(loads: PersonLoad[], scored: ScoredItem[], now: number): Handoff[] {
  const byId = new Map(scored.map(s => [s.item.id, s]));
  const out: Handoff[] = [];
  const extraHours = new Map<string, number>();
  for (const load of loads.filter(l => l.status === 'overloaded')) {
    const mates = loads.filter(l => l.person.teamId === load.person.teamId && l.person.id !== load.person.id);
    const candidates = load.atRiskItemIds.map(id => byId.get(id)!).sort((a, b) => b.score - a.score);
    // If nothing is at risk yet, still offload the biggest lower-priority item.
    if (!candidates.length) {
      const mine = scored.filter(s => s.item.assigneeId === load.person.id && queued(s)).sort((a, b) => a.score - b.score);
      if (mine[0]) candidates.push(mine.sort((a, b) => b.item.effortHours - a.item.effortHours)[0]);
    }
    for (const s of candidates.slice(0, 2)) {
      const it = s.item;
      const ranked = mates
        .map(m => ({ m, skill: it.skills.filter(k => m.person.skills.includes(k)).length,
          hours: m.queuedHours + (extraHours.get(m.person.id) ?? 0) }))
        .filter(x => x.skill > 0)
        .sort((a, b) => Number(a.m.person.role === 'Team Lead') - Number(b.m.person.role === 'Team Lead')
          || a.hours / Math.max(1, a.m.person.capacityHoursPerWeek) - b.hours / Math.max(1, b.m.person.capacityHoursPerWeek) || b.skill - a.skill);
      const pick = ranked[0];
      if (!pick || pick.m.status === 'overloaded') continue;
      // Rough projection: the item lands in the teammate's queue ahead of everything with a lower score.
      const ahead = scored.filter(x => x.item.assigneeId === pick.m.person.id && queued(x) && x.score >= s.score)
        .reduce((h, x) => h + x.item.effortHours, 0);
      const finishAfter = now + ((ahead + it.effortHours) / PRODUCTIVE_PER_DAY) * 24 * HOUR;
      const mineAhead = scored.filter(x => x.item.assigneeId === load.person.id && queued(x) && x.score >= s.score)
        .reduce((h, x) => h + x.item.effortHours, 0);
      const finishNow = now + (mineAhead / PRODUCTIVE_PER_DAY) * 24 * HOUR;
      extraHours.set(pick.m.person.id, (extraHours.get(pick.m.person.id) ?? 0) + it.effortHours);
      out.push({
        itemId: it.id, fromId: load.person.id, toId: pick.m.person.id,
        projectedBreachAt: new Date(finishNow).toISOString(), projectedFinishAfterHandoff: new Date(finishAfter).toISOString(),
        reason: `${load.person.name.split(' ')[0]} has ${load.queuedHours} h queued; ${it.externalId} would finish ${fmtHours((finishNow - now) / HOUR)}, `
          + `due ${fmtHours((dueAt(s) - now) / HOUR)}. ${pick.m.person.name.split(' ')[0]} has ${Math.round(pick.hours)} h queued `
          + `and knows ${it.skills.filter(k => pick.m.person.skills.includes(k)).join(', ')}.`,
      });
    }
  }
  return out;
}

export function itemsOf(personId: string, items: WorkItem[]) {
  return items.filter(i => i.assigneeId === personId && i.status !== 'Resolved');
}
