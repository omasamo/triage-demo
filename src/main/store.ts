// Local persistence for the desktop app: one SQLite file in the user's app-data folder.
// Holds AI signals already computed (so the mailbox is not re-analysed on every start),
// manager overrides and the audit log. Falls back to a JSON file if node:sqlite is unavailable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { EmailSignals, ManualOverride } from '../core/types.ts';
import type { AuditEntry } from '../core/engine.ts';

export interface Store {
  cachedSignals(): Map<string, { signals: EmailSignals; engine: string }>;
  saveSignals(emailId: string, engine: string, s: EmailSignals): void;
  overrides(): ManualOverride[];
  saveOverrides(list: ManualOverride[]): void;
  appendAudit(entries: AuditEntry[]): void;
  kind: string;
}

export function openStore(file: string): Store {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      create table if not exists signals (email_id text primary key, engine text not null, json text not null, at text default current_timestamp);
      create table if not exists overrides (item_id text primary key, json text not null);
      create table if not exists audit (id integer primary key autoincrement, at text, kind text, item_id text, message text, engine text);`);
    const seen = new Set<string>();
    return {
      kind: `SQLite (${file})`,
      cachedSignals: () => new Map((db.prepare('select email_id, engine, json from signals').all() as { email_id: string; engine: string; json: string }[])
        .map(r => [r.email_id, { engine: r.engine, signals: JSON.parse(r.json) }])),
      saveSignals: (id, engine, s) => { db.prepare('insert or replace into signals (email_id, engine, json) values (?, ?, ?)').run(id, engine, JSON.stringify(s)); },
      overrides: () => (db.prepare('select json from overrides').all() as { json: string }[]).map(r => JSON.parse(r.json)),
      saveOverrides: list => {
        db.exec('delete from overrides');
        const ins = db.prepare('insert into overrides (item_id, json) values (?, ?)');
        for (const o of list) ins.run(o.itemId, JSON.stringify(o));
      },
      appendAudit: entries => {
        const ins = db.prepare('insert into audit (at, kind, item_id, message, engine) values (?, ?, ?, ?, ?)');
        for (const e of entries) {
          const key = `${e.at}|${e.kind}|${e.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ins.run(e.at, e.kind, e.itemId ?? null, e.message, e.engine ?? null);
        }
      },
    };
  } catch {
    const json = file.replace(/\.db$/, '.json');
    const state = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : { signals: {}, overrides: [], audit: [] };
    const save = () => writeFileSync(json, JSON.stringify(state));
    return {
      kind: `JSON (${json})`,
      cachedSignals: () => new Map(Object.entries(state.signals)),
      saveSignals: (id, engine, s) => { state.signals[id] = { engine, signals: s }; save(); },
      overrides: () => state.overrides,
      saveOverrides: list => { state.overrides = list; save(); },
      appendAudit: entries => { state.audit = [...entries, ...state.audit].slice(0, 5000); save(); },
    };
  }
}
