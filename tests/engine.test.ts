import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.ts';
import { answerWithoutModel } from '../src/core/chat.ts';
import { openStore } from '../src/main/store.ts';
import { LocalModels } from '../src/node/llm.ts';
import { DEFAULT_CONFIG } from '../src/node/config.ts';
import type { Dataset } from '../src/core/types.ts';

const data = JSON.parse(readFileSync('data/dataset.json', 'utf8')) as Dataset;
const fresh = async () => { const e = new Engine(data); await e.ingestHistory(); return e; };
const id = (ext: string) => data.items.find(i => i.externalId === ext)!.id;

test('Acme go-live email raises INT-400 to P1 and lifts its blocker', async () => {
  const e = await fresh();
  const r = await e.receiveNext();
  assert.equal(r?.processed.link.itemId, id('INT-400'));
  const changes = new Map(r!.changes.map(c => [c.itemId, c]));
  assert.equal(changes.get(id('INT-400'))?.toBand, 'P1');
  assert.ok(changes.get(id('OPS-1100')), 'blocker OPS-1100 should move too');
});

test('prompt-injection email changes no score', async () => {
  const e = await fresh();
  let r;
  do { r = await e.receiveNext(); } while (r && !r.processed.signals.suspiciousInstructions);
  assert.ok(r, 'injection email exists in the demo stream');
  assert.equal(r!.changes.length, 0);
  assert.equal(r!.processed.link.itemId, null);
});

test('manager override pins the band and is audited; clearing restores it', async () => {
  const e = await fresh();
  const item = e.snapshot().scored.at(-1)!;
  e.setOverride(item.item.id, 'P1', 'Strategic renewal');
  const after = e.scores().get(item.item.id)!;
  assert.equal(after.band, 'P1');
  assert.equal(after.factors[0].key, 'override');
  assert.match(e.audit[0].message, /Strategic renewal/);
  e.setOverride(item.item.id, null, '');
  assert.equal(e.scores().get(item.item.id)!.band, item.band);
});

test('overloaded people get skill-matched hand-off suggestions within their team', async () => {
  const s = (await fresh()).snapshot();
  assert.ok(s.loads.filter(l => l.status === 'overloaded').length >= 2);
  for (const h of s.handoffs) {
    const from = s.people.find(p => p.id === h.fromId)!, to = s.people.find(p => p.id === h.toId)!;
    const it = s.items.find(i => i.id === h.itemId)!;
    assert.equal(from.teamId, to.teamId);
    assert.ok(it.skills.some(k => to.skills.includes(k)));
  }
});

test('rule-based chat answers the blocker question with the blocking ticket', async () => {
  const a = answerWithoutModel('What is blocking the Acme go-live?', (await fresh()).snapshot());
  assert.match(a.text, /OPS-1100/);
  assert.ok(a.refs.includes(id('INT-400')));
});

test('SQLite store round-trips signals and overrides', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  const st = openStore(path.join(dir, 't.db'));
  const e = data.emails[0];
  st.saveSignals(e.id, 'test', { ticketRefs: [], isEscalation: true, isDeescalation: false, urgency: 'high', deadline: null, customerImpact: 'team', sentiment: 'neutral', executiveInvolved: false, evidence: 'x', summary: 'y', suspiciousInstructions: false });
  st.saveOverrides([{ itemId: 'a', band: 'P2', reason: 'r', by: 'me', at: data.now }]);
  const again = openStore(path.join(dir, 't.db'));
  assert.equal(again.cachedSignals().get(e.id)?.signals.urgency, 'high');
  assert.equal(again.overrides()[0].band, 'P2');
  assert.match(again.kind, /SQLite/);
});

test('without a model file the local backend reports no-model instead of failing', async () => {
  const m = new LocalModels(DEFAULT_CONFIG, mkdtempSync(path.join(os.tmpdir(), 'models-')));
  assert.equal(await m.locate(), false);
  assert.equal((await m.status()).mode, 'rules');
});

test('model JSON parsing tolerates text around the object', async () => {
  const { parseModelJson } = await import('../src/node/llm.ts');
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('<think>\n</think>\n{"a":"x}y","b":{"c":2}} trailing'), { a: 'x}y', b: { c: 2 } });
  assert.throws(() => parseModelJson('no json here'));
});
