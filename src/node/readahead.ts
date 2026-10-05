// Background reading for the desktop app (Node only).
import type { Email } from '../core/types.ts';
import type { AiProvider, TimedSignals } from '../core/engine.ts';
import { heuristicSignals } from '../core/ai/heuristic.ts';
import type { AiBackend } from './llm.ts';

export type ReadAheadProvider = AiProvider & { readAhead(left: number): Promise<void>; stop(): void };

/** Reads the next few demo emails with the model in the background, so "Next email" is instant even on a slow
 *  laptop and still shows the model's real reading time. In production mail is read as it arrives, the same way.
 *  Reads go one at a time, so a chat question never waits behind more than one email. */
export function readAheadProvider(b: AiBackend, incoming: Email[], startNow: string, ahead = 3): ReadAheadProvider {
  const cache = new Map<string, Promise<TimedSignals>>();
  const read = (e: Email, nowIso: string) => {
    let p = cache.get(e.id);
    if (!p) {
      p = b.extract(e, nowIso).then(r => ({ signals: r.signals, latencyMs: Math.round(r.ms) }))
        .catch(err => { console.warn(`[ai] ${e.id}: ${(err as Error).message}`); return { signals: heuristicSignals(e, nowIso), latencyMs: 0 }; });
      cache.set(e.id, p);
    }
    return p;
  };
  let stopped = false;
  return {
    name: b.provider().name,
    extract: (e, nowIso) => read(e, nowIso),
    async readAhead(left) {
      for (const e of incoming.slice(incoming.length - left).slice(0, ahead)) {
        if (stopped) return;
        // The engine's clock moves to each email's arrival time, so read it with that clock.
        await read(e, new Date(Math.max(Date.parse(startNow), Date.parse(e.receivedAt))).toISOString());
      }
    },
    stop() { stopped = true; },
  };
}
