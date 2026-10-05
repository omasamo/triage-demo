import { useEffect, useState } from 'react';
import { X, Link2, Lock, Mail, Sparkles, UserRoundCog, Pin, CornerDownRight } from 'lucide-react';
import { useApp } from '../App.tsx';
import type { Band } from '../../core/types.ts';
import { Avatar, BandChip, SourceBadge, Tag, Tier, fmtDate, isAiFactor, rel, slaText } from './ui.tsx';

const BANDS: Band[] = ['P1', 'P2', 'P3', 'P4'];

export function ItemDrawer({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { s, open, override, go } = useApp();
  const it = s.items.find(i => i.id === itemId);
  const sc = s.scored.find(x => x.item.id === itemId);
  const [band, setBand] = useState<Band | null>(sc?.override?.band ?? null);
  const [reason, setReason] = useState(sc?.override?.reason ?? '');
  useEffect(() => { setBand(sc?.override?.band ?? null); setReason(sc?.override?.reason ?? ''); }, [itemId, sc?.override?.at]);
  if (!it) return null;
  const person = (id: string) => s.people.find(p => p.id === id);
  const customer = s.customers.find(c => c.id === it.customerId);
  const team = s.teams.find(t => t.id === it.teamId);
  const sla = slaText(it.slaDueAt, s.now);
  const mails = s.processed.filter(p => p.link.itemId === it.id);
  const blockers = it.blockedByIds.map(id => s.scored.find(x => x.item.id === id) ?? { item: s.items.find(i => i.id === id)!, band: undefined, score: 0 });
  const blocks = s.items.filter(i => i.blockedByIds.includes(it.id));
  const linked = it.linkedIds.map(id => s.items.find(i => i.id === id)!).filter(Boolean);
  const maxPts = Math.max(40, ...(sc?.factors ?? []).map(f => Math.abs(f.points)));
  const handoff = s.handoffs.find(h => h.itemId === it.id);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${it.externalId} details`}>
        <div className="drawer-head">
          <div className="row">
            <SourceBadge source={it.source} /><span className="mono muted">{it.externalId}</span>
            {sc && <BandChip band={sc.band} />}
            {sc?.override && <Tag color="blue"><Pin size={11} /> Manager set</Tag>}
            <span className="grow" />
            <button className="btn subtle" aria-label="Close" onClick={onClose}><X size={18} /></button>
          </div>
          <h2>{it.title}</h2>
          <div className="row small muted" style={{ flexWrap: 'wrap' }}>
            <span>{customer?.name}</span><Tier c={customer} /><span>·</span><span>{team?.name}</span><span>·</span>
            <Avatar person={person(it.assigneeId)} /><span>{person(it.assigneeId)?.name}</span>
          </div>
        </div>
        <div className="drawer-body">
          {sc ? (
            <section>
              <div className="row" style={{ marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>Why it ranks here</h3><span className="grow" />
                <span className="muted small">Score</span><b style={{ fontSize: 20 }}>{sc.score}</b>
              </div>
              <div>
                {sc.factors.map((f, i) => (
                  <div key={i} className={`factor ${isAiFactor(f.key) ? 'ai' : ''} ${f.key === 'override' ? 'override' : ''}`}>
                    <div>
                      <div className="row" style={{ gap: 6 }}>
                        <b style={{ fontWeight: 600 }}>{f.label}</b>
                        {isAiFactor(f.key) && <Tag color="purple"><Sparkles size={10} /> from email</Tag>}
                      </div>
                      <div className="small muted">{f.detail}</div>
                    </div>
                    <div className={`pts ${f.points < 0 ? 'neg' : ''}`}>{f.points > 0 ? '+' : ''}{f.points}</div>
                    {f.key !== 'override' && <div className="bar"><span style={{ width: `${(Math.abs(f.points) / maxPts) * 100}%`, opacity: f.points < 0 ? .4 : 1 }} /></div>}
                  </div>
                ))}
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>The score is a sum of named factors with weights you can tune in Settings. The AI only supplies the email signals marked in purple.</p>
            </section>
          ) : <div className="banner info">This item is resolved and no longer ranked.</div>}

          {sc && (
            <section className="override-box">
              <div className="row"><UserRoundCog size={16} /><h3 style={{ margin: 0 }}>Manager priority</h3></div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <div className="seg" role="radiogroup" aria-label="Priority">
                  <button className={band === null ? 'on' : ''} onClick={() => setBand(null)}>Auto ({sc.override ? 'computed' : sc.band})</button>
                  {BANDS.map(b => <button key={b} className={band === b ? 'on' : ''} onClick={() => setBand(b)}>{b}</button>)}
                </div>
              </div>
              {band && <textarea className="input" placeholder="Reason (required for the audit log), e.g. Strategic account, renewal next week" value={reason} onChange={e => setReason(e.target.value)} />}
              <div className="row">
                <button className="btn primary" disabled={(band !== null && !reason.trim()) || (band === (sc.override?.band ?? null) && reason === (sc.override?.reason ?? ''))}
                  onClick={() => void override(it.id, band, reason)}>{band ? `Set ${band}` : 'Use computed priority'}</button>
                <span className="small muted">Overrides are recorded with your name and reason, and shown to the team.</span>
              </div>
            </section>
          )}

          <section>
            <h3>Details</h3>
            <dl className="facts">
              <dt>Status</dt><dd>{it.status}</dd>
              <dt>Severity</dt><dd>S{it.severity}</dd>
              <dt>SLA due</dt><dd><Tag color={sla.cls}>{sla.text}</Tag> <span className="muted small">{fmtDate(it.slaDueAt)}</span></dd>
              {it.goLiveAt && <><dt>Go-live</dt><dd>{fmtDate(it.goLiveAt)} ({rel(it.goLiveAt, s.now)})</dd></>}
              <dt>Effort left</dt><dd>{it.effortHours} h</dd>
              <dt>Skills</dt><dd>{it.skills.join(', ')}</dd>
              <dt>Last update</dt><dd>{rel(it.updatedAt, s.now)}</dd>
              <dt>Description</dt><dd>{it.description}</dd>
            </dl>
            {handoff && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                <UserRoundCog size={16} />
                <div className="grow small">Suggested hand-off to <b>{person(handoff.toId)?.name}</b>. {handoff.reason}
                  <div><button className="btn sm" style={{ marginTop: 6 }} onClick={() => { onClose(); go('workload'); }}>Review on Workload</button></div>
                </div>
              </div>
            )}
          </section>

          {(blockers.length > 0 || blocks.length > 0 || linked.length > 0) && (
            <section>
              <h3>Dependencies across systems</h3>
              <div className="chain">
                {blockers.map(b => (
                  <div key={b.item.id}>
                    <div className="chain-node" onClick={() => open(b.item.id)}>
                      <Lock size={16} color="var(--danger)" style={{ marginTop: 2 }} />
                      <div className="grow">
                        <div className="row small"><b>Blocked by</b><SourceBadge source={b.item.source} /><span className="mono">{b.item.externalId}</span>{b.band && <BandChip band={b.band} />}</div>
                        <div>{b.item.title}</div>
                        <div className="small muted">{person(b.item.assigneeId)?.name} · {b.item.status} · {s.loads.find(l => l.person.id === b.item.assigneeId)?.status === 'overloaded' ? 'owner is overloaded' : 'owner has capacity'}</div>
                      </div>
                    </div>
                    <div className="chain-link" />
                  </div>
                ))}
                <div className="chain-node" style={{ borderColor: 'var(--brand)', cursor: 'default' }}>
                  <CornerDownRight size={16} style={{ marginTop: 2 }} /><div><b className="small">This item</b><div>{it.externalId} · {it.title}</div></div>
                </div>
                {blocks.map(b => (
                  <div key={b.id}><div className="chain-link" />
                    <div className="chain-node" onClick={() => open(b.id)}>
                      <Lock size={16} color="var(--warn)" style={{ marginTop: 2 }} />
                      <div><div className="row small"><b>Blocks</b><SourceBadge source={b.source} /><span className="mono">{b.externalId}</span></div><div>{b.title}</div></div>
                    </div>
                  </div>
                ))}
                {linked.map(l => (
                  <div key={l.id}><div className="chain-link" />
                    <div className="chain-node" onClick={() => open(l.id)}>
                      <Link2 size={16} style={{ marginTop: 2 }} />
                      <div><div className="row small"><b>Linked</b><SourceBadge source={l.source} /><span className="mono">{l.externalId}</span></div><div>{l.title}</div></div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>Emails ({mails.length})</h3>
            {!mails.length && <div className="small muted">No linked emails.</div>}
            <div className="col">
              {mails.slice(0, 6).map(p => (
                <div key={p.email.id} className="mail">
                  <div className="row small">
                    <Mail size={14} /><b>{p.email.fromName}</b><span className="muted">{rel(p.email.receivedAt, s.now)}</span><span className="grow" />
                    {p.signals.isEscalation && <Tag color="red">Escalation · {p.signals.urgency}</Tag>}
                    {p.signals.isDeescalation && <Tag color="green">De-escalation</Tag>}
                    {p.signals.deadline && <Tag color="orange">Deadline {fmtDate(p.signals.deadline)}</Tag>}
                  </div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{p.email.subject}</div>
                  {p.signals.evidence && (p.signals.isEscalation || p.signals.isDeescalation || p.signals.deadline) && <p className="quote">"{p.signals.evidence}"</p>}
                  <div className="small muted" style={{ marginTop: 6 }}>Linked by {p.link.method} ({Math.round(p.link.confidence * 100)}%) · read by {p.engine}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
