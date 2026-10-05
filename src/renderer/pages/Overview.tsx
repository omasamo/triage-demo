import { AlertTriangle, ArrowRight, Clock, Flame, Mail, TrendingDown, TrendingUp, Users, ListChecks } from 'lucide-react';
import { useApp } from '../App.tsx';
import { Avatar, BandChip, ScoreBar, SourceBadge, Tag, rel, slaText } from '../components/ui.tsx';

export function Overview() {
  const { s, go, open, next, busy } = useApp();
  const now = Date.parse(s.now);
  const open_ = s.scored.length;
  const p1 = s.scored.filter(x => x.band === 'P1');
  const breaches = s.scored.filter(x => x.item.status !== 'Waiting on Customer' && Date.parse(x.item.slaDueAt) - now < 24 * 3600_000);
  const breached = breaches.filter(x => Date.parse(x.item.slaDueAt) < now);
  const escToday = s.processed.filter(p => p.signals.isEscalation && now - Date.parse(p.email.receivedAt) < 24 * 3600_000);
  const overloaded = s.loads.filter(l => l.status === 'overloaded');
  const person = (id: string) => s.people.find(p => p.id === id);
  const customer = (id: string) => s.customers.find(c => c.id === id);
  // Only critical reminders interrupt someone; the rest are batched into one digest per person.
  const critical = s.reminders.filter(r => r.severity === 'critical');
  const digestPeople = new Set(s.reminders.filter(r => r.severity !== 'critical').map(r => r.personId)).size;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Good morning, Dana</h1>
          <p>{open_} open items across Siebel and Jira, {s.processed.length} emails read. Here is what needs you today.</p>
        </div>
        {s.incomingLeft > 0 && (
          <button className="btn" onClick={() => void next()} disabled={busy} title={s.nextIncoming ? `${s.nextIncoming.fromName}: ${s.nextIncoming.subject}` : ''}>
            <Mail size={16} /> Simulate next email
          </button>
        )}
      </div>

      <div className="kpis">
        <button className="card kpi alert" onClick={() => go('queue', { filter: { band: 'P1' } })}>
          <div className="label"><Flame size={14} /> P1 right now</div><div className="value">{p1.length}</div>
          <div className="delta">{s.changes.filter(c => c.toBand === 'P1').length} raised by email today</div>
        </button>
        <button className="card kpi" onClick={() => go('queue', { filter: { due: '24h' } })}>
          <div className="label"><Clock size={14} /> SLA due in 24 h</div><div className="value">{breaches.length}</div>
          <div className="delta" style={{ color: breached.length ? 'var(--danger)' : undefined }}>{breached.length} already breached</div>
        </button>
        <button className="card kpi" onClick={() => go('inbox')}>
          <div className="label"><Mail size={14} /> Escalations by email (24 h)</div><div className="value">{escToday.length}</div>
          <div className="delta">from {s.processed.length} emails read</div>
        </button>
        <button className="card kpi" onClick={() => go('workload')}>
          <div className="label"><Users size={14} /> People overloaded</div><div className="value" style={{ color: overloaded.length ? 'var(--warn)' : undefined }}>{overloaded.length}</div>
          <div className="delta">{s.handoffs.length} hand-offs suggested</div>
        </button>
        <button className="card kpi" onClick={() => go('workload')}>
          <div className="label"><ListChecks size={14} /> Urgent nudges</div><div className="value">{critical.length}</div>
          <div className="delta">{s.reminders.length - critical.length} more wait for {digestPeople} daily digests</div>
        </button>
      </div>

      <div className="split">
        <div className="card">
          <div className="card-head"><h2>Top priorities</h2><span className="sub">ranked across all teams and systems</span><span className="grow" />
            <button className="btn subtle sm" onClick={() => go('queue')}>Full queue <ArrowRight size={12} /></button></div>
          <div className="table-wrap">
          <table className="table">
            <thead><tr><th></th><th>Item</th><th>Owner</th><th>SLA</th><th>Score</th></tr></thead>
            <tbody>
              {s.scored.slice(0, 9).map(x => {
                const sla = slaText(x.item.slaDueAt, s.now);
                return (
                  <tr key={x.item.id} onClick={() => open(x.item.id)}>
                    <td><BandChip band={x.band} /></td>
                    <td className="title-cell"><div className="row small"><SourceBadge source={x.item.source} /><span className="mono muted">{x.item.externalId}</span><span className="muted">· {customer(x.item.customerId)?.name}</span></div><div className="ellipsis">{x.item.title}</div></td>
                    <td><Avatar person={person(x.item.assigneeId)} /></td>
                    <td><Tag color={sla.cls}>{sla.text}</Tag></td>
                    <td><div className="row"><ScoreBar s={x} width={56} /><b className="small">{x.score}</b></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Moved by email</h2><span className="sub">priority changes the AI detected</span></div>
          {!s.changes.length && (
            <div className="empty">
              <Mail size={28} style={{ opacity: .4 }} />
              <div style={{ marginTop: 8 }}>No changes yet today.</div>
              <div className="small">Press <b>Next email</b> (or N) to let the next customer email arrive.</div>
            </div>
          )}
          <div className="feed" style={{ maxHeight: 470, overflowY: 'auto' }}>
            {s.changes.slice(0, 8).map((c, i) => {
              const it = s.items.find(x => x.id === c.itemId)!;
              const up = c.toScore > c.fromScore;
              return (
                <div key={i} className="feed-item" onClick={() => open(c.itemId)}>
                  <div className="feed-icon" style={{ background: up ? 'var(--p1-soft)' : 'var(--ok-soft)', color: up ? 'var(--p1)' : 'var(--ok)' }}>{up ? <TrendingUp size={18} /> : <TrendingDown size={18} />}</div>
                  <div className="grow">
                    <div className="row"><span className="feed-title mono">{it.externalId}</span><BandChip band={c.fromBand as never} /><ArrowRight size={12} /><BandChip band={c.toBand as never} /><span className="grow" /><span className="small muted">{rel(c.at, s.now)}</span></div>
                    <div className="small" style={{ marginTop: 2 }}>{it.title} · {customer(it.customerId)?.name}</div>
                    <div className="small muted" style={{ marginTop: 2 }}>{c.reason}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="teams">
        {s.teams.map(t => {
          const loads = s.loads.filter(l => l.person.teamId === t.id);
          const items = s.scored.filter(x => x.item.teamId === t.id);
          return (
            <div className="card" key={t.id}>
              <div className="card-head"><h2>{t.name}</h2><span className="grow" />
                <BandChip band="P1" /><span className="small">{items.filter(x => x.band === 'P1').length}</span>
                <BandChip band="P2" /><span className="small">{items.filter(x => x.band === 'P2').length}</span>
              </div>
              <div className="small muted" style={{ marginBottom: 8 }}>{t.focus}</div>
              {loads.map(l => {
                const pct = Math.min(1.6, l.loadRatio) / 1.6 * 100;
                const color = l.status === 'overloaded' ? 'var(--danger)' : l.status === 'busy' ? 'var(--warn)' : 'var(--ok)';
                return (
                  <div className="loadrow" key={l.person.id} title={`${l.queuedHours} h queued, ${Math.round(l.loadRatio * 100)}% of remaining capacity`}>
                    <Avatar person={l.person} />
                    <span className="small ellipsis">{l.person.name}{l.person.role === 'Team Lead' ? ' (lead)' : ''}</span>
                    <div className="loadbar"><span style={{ width: `${pct}%`, background: color }} /><i className="cap" style={{ left: `${100 / 1.6}%` }} /></div>
                    <span className="small" style={{ textAlign: 'right', color }}>{Math.round(l.loadRatio * 100)}%</span>
                  </div>
                );
              })}
              {loads.some(l => l.status === 'overloaded') && (
                <button className="btn sm" style={{ marginTop: 8 }} onClick={() => go('workload')}><AlertTriangle size={12} /> Review hand-offs</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
