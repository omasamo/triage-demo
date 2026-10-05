import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldAlert, Sparkles, Link2, Timer } from 'lucide-react';
import { useApp } from '../App.tsx';
import type { ProcessedEmail } from '../../core/types.ts';
import { BandChip, SourceBadge, Tag, fmtDate, rel } from '../components/ui.tsx';
import { pressable } from '../components/insight.tsx';

const isSignal = (p: ProcessedEmail) => p.signals.isEscalation || p.signals.isDeescalation || p.signals.suspiciousInstructions || !!p.signals.deadline;

export function Inbox() {
  const { s, open, routeOpts, ai } = useApp();
  const [filter, setFilter] = useState<'signals' | 'linked' | 'all'>('signals');
  const list = useMemo(() => s.processed.filter(p => filter === 'all' || (filter === 'signals' ? isSignal(p) : !!p.link.itemId)), [s, filter]);
  const [sel, setSel] = useState<string | null>(routeOpts.emailId ?? list[0]?.email.id ?? null);
  useEffect(() => { if (!sel && list[0]) setSel(list[0].email.id); }, [list, sel]);
  // A deep link (from "Read the email") wins over jumping to the newest signal.
  const deepLinked = useRef(!!routeOpts.emailId);
  useEffect(() => {
    if (!routeOpts.emailId) return;
    setSel(routeOpts.emailId);
    const m = s.processed.find(x => x.email.id === routeOpts.emailId);
    if (m && !isSignal(m)) setFilter('all');
  }, [routeOpts]);
  useEffect(() => {
    if (deepLinked.current) { deepLinked.current = false; return; }
    if (s.processed[0] && filter === 'signals' && isSignal(s.processed[0])) setSel(s.processed[0].email.id);
  }, [s.processed.length]);
  const p = s.processed.find(x => x.email.id === sel);
  const linked = p?.link.itemId ? s.items.find(i => i.id === p.link.itemId) : undefined;
  const scored = linked ? s.scored.find(x => x.item.id === linked.id) : undefined;
  const change = p ? s.changes.filter(c => c.emailId === p.email.id) : [];

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Email signals</h1><p>Every email in the support mailbox is read by {ai?.mode === 'local-llm' ? 'the local model' : ai?.mode === 'team-hub' ? 'your team hub model' : 'the AI engine (the rule engine in this web demo; the desktop app uses a local model)'}, linked to a ticket and turned into structured signals. Nothing leaves this machine.</p></div>
        <div className="tabs" style={{ margin: 0, border: 0 }}>
          {(['signals', 'linked', 'all'] as const).map(f => <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'signals' ? 'Signals' : f === 'linked' ? 'Linked to tickets' : 'All mail'}</button>)}
        </div>
      </div>
      <div className="inbox">
        <div className="card list">
          {list.map(x => (
            <div key={x.email.id} className={`mrow ${x.email.id === sel ? 'sel' : ''}`} aria-current={x.email.id === sel} {...pressable(() => setSel(x.email.id))}>
              <div className="row"><b className="grow ellipsis">{x.email.fromName}</b><span className="small muted nowrap">{rel(x.email.receivedAt, s.now)}</span></div>
              <div className="ellipsis small">{x.email.subject}</div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {x.signals.suspiciousInstructions && <Tag color="red"><ShieldAlert size={10} /> Blocked</Tag>}
                {x.signals.isEscalation && <Tag color="red">Escalation · {x.signals.urgency}</Tag>}
                {x.signals.isDeescalation && <Tag color="green">De-escalation</Tag>}
                {x.signals.deadline && <Tag color="orange"><Timer size={10} /> Deadline</Tag>}
                {x.link.itemId && <Tag><Link2 size={10} /> {s.items.find(i => i.id === x.link.itemId)?.externalId}</Tag>}
                {!isSignal(x) && !x.link.itemId && <Tag>No action</Tag>}
              </div>
            </div>
          ))}
          {!list.length && <div className="empty">No emails in this view.</div>}
        </div>
        <div className="card reader">
          {!p ? <div className="empty">Select an email</div> : (
            <div className="col" style={{ gap: 16 }}>
              <div>
                <div className="row small muted"><SourceBadge source="outlook" /><span>{p.email.mailbox}</span><span className="grow" /><span>{fmtDate(p.email.receivedAt)}</span></div>
                <h2 style={{ fontSize: 20, margin: '8px 0 4px' }}>{p.email.subject}</h2>
                <div className="small">From <b>{p.email.fromName}</b> &lt;{p.email.from}&gt;</div>
              </div>
              {p.signals.suspiciousInstructions && (
                <div className="banner danger"><ShieldAlert size={18} color="var(--danger)" />
                  <div className="small"><b>Prompt injection blocked.</b> This email contains instructions aimed at an AI. The model only fills a fixed schema and never takes actions from email content, so no ticket was changed. The sender domain also does not match any known customer.</div></div>
              )}
              {change.map((c, i) => {
                const it = s.items.find(x => x.id === c.itemId)!;
                return (
                  <div key={i} className="banner warn" style={{ cursor: 'pointer' }} {...pressable(() => open(c.itemId))}>
                    <Sparkles size={18} color="var(--warn)" />
                    <div className="small grow"><b>{it.externalId} moved {c.fromBand} → {c.toBand}</b> (score {c.fromScore} → {c.toScore}). {c.reason}</div>
                  </div>
                );
              })}
              <div className="mail-body" style={{ maxHeight: 'none', fontSize: 14, border: '1px solid var(--stroke)', borderRadius: 6, padding: 14 }}>{p.email.body}</div>
              <div>
                <div className="row" style={{ marginBottom: 8 }}><Sparkles size={16} color="#8764b8" /><h3 style={{ margin: 0, fontSize: 14 }}>What the AI extracted</h3><span className="grow" /><span className="small muted">{p.engine}{p.latencyMs ? ` · ${(p.latencyMs / 1000).toFixed(1)} s` : ''}</span></div>
                <div className="signal-grid">
                  <Signal k="Escalation" v={p.signals.isEscalation ? `Yes (${p.signals.urgency})` : p.signals.isDeescalation ? 'De-escalation' : 'No'} />
                  <Signal k="Deadline" v={p.signals.deadline ? fmtDate(p.signals.deadline) : 'None'} note={p.signals.deadline && p.signals.deadlineText ? `from "${p.signals.deadlineText}"` : undefined} />
                  <Signal k="Customer impact" v={p.signals.customerImpact.replace('_', ' ')} />
                  <Signal k="Sentiment" v={p.signals.sentiment} />
                  <Signal k="Executive involved" v={p.signals.executiveInvolved ? 'Yes' : 'No'} />
                  <Signal k="Ticket ids found" v={p.signals.ticketRefs.join(', ') || 'None'} />
                </div>
                {p.signals.evidence && <p className="quote">"{p.signals.evidence}"</p>}
              </div>
              <div>
                <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Linked ticket</h3>
                {linked ? (
                  <div className="chain-node" {...pressable(() => open(linked.id))}>
                    <Link2 size={16} style={{ marginTop: 2 }} />
                    <div className="grow">
                      <div className="row small"><SourceBadge source={linked.source} /><span className="mono">{linked.externalId}</span>{scored && <BandChip band={scored.band} />}</div>
                      <div>{linked.title}</div>
                      <div className="small muted">Matched by {p.link.method} with {Math.round(p.link.confidence * 100)}% confidence</div>
                    </div>
                  </div>
                ) : <div className="small muted">{p.signals.suspiciousInstructions ? 'Not linked: suspicious emails are quarantined.' : 'Not related to any open ticket.'}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Signal = ({ k, v, note }: { k: string; v: string; note?: string }) => (
  <div className="signal"><div className="k">{k}</div><div className="v" style={{ textTransform: 'capitalize' }}>{v}</div>{note && <div className="small muted">{note}</div>}</div>
);
