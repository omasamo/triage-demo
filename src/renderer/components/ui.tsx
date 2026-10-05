import type { ReactNode } from 'react';
import type { Band, Person, ScoredItem, SourceSystem, Customer } from '../../core/types.ts';

const PALETTE = ['#0f6cbd', '#8764b8', '#c239b3', '#038387', '#ca5010', '#4f6bed', '#498205', '#986f0b', '#e43ba6', '#00666d', '#7a7574', '#b4009e'];
export function Avatar({ person, size }: { person?: Person; size?: 'lg' }) {
  if (!person) return null;
  const initials = person.name.split(' ').map(p => p[0]).join('').slice(0, 2);
  const color = PALETTE[[...person.id].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
  return <span className={`avatar ${size ?? ''}`} style={{ background: color }} title={person.name}>{initials}</span>;
}

export const BandChip = ({ band, title }: { band: Band; title?: string }) => <span className={`band ${band}`} title={title}>{band}</span>;

export const SourceBadge = ({ source }: { source: SourceSystem }) =>
  <span className={`src ${source}`}><i />{source === 'siebel' ? 'Siebel' : source === 'jira' ? 'Jira' : 'Outlook'}</span>;

export const Tier = ({ c }: { c?: Customer }) => c ? <span className={`tier ${c.tier}`}>{c.tier}</span> : null;

export function Tag({ color, children, title }: { color?: 'red' | 'orange' | 'green' | 'blue' | 'purple'; children: ReactNode; title?: string }) {
  return <span className={`tag ${color ?? ''}`} title={title}>{children}</span>;
}

/** Positive score factors as a stacked bar: AI-derived signals in purple, record fields in blue. */
const AI_KEYS = new Set(['escalation', 'executive', 'deadline', 'sentiment', 'deescalation']);
export function ScoreBar({ s, max = 160, width = 96 }: { s: ScoredItem; max?: number; width?: number }) {
  const pos = s.factors.filter(f => f.points > 0);
  return (
    <div className="scorebar" style={{ width }} title={s.factors.map(f => `${f.points > 0 ? '+' : ''}${f.points} ${f.label}`).join('\n')}>
      {pos.map((f, i) => <span key={i} style={{ width: `${(f.points / max) * 100}%`, background: f.key === 'override' ? '#4f6bed' : AI_KEYS.has(f.key) ? '#8764b8' : `color-mix(in srgb, var(--brand) ${100 - i * 12}%, transparent)` }} />)}
    </div>
  );
}
export const isAiFactor = (k: string) => AI_KEYS.has(k);

export function rel(iso: string, nowIso: string) {
  const h = (Date.parse(iso) - Date.parse(nowIso)) / 3600_000;
  const a = Math.abs(h);
  if (a < 1 / 60) return 'just now';
  const s = a < 1 ? `${Math.max(1, Math.round(a * 60))} min` : a < 48 ? `${Math.round(a)} h` : `${Math.round(a / 24)} d`;
  return h < 0 ? `${s} ago` : `in ${s}`;
}
export function slaText(iso: string, nowIso: string) {
  const h = (Date.parse(iso) - Date.parse(nowIso)) / 3600_000;
  return { text: h < 0 ? `Breached ${rel(iso, nowIso).replace(' ago', '')}` : rel(iso, nowIso), cls: h < 0 ? 'red' : h < 8 ? 'orange' : undefined } as const;
}
export const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
