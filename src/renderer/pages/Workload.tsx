import { useState } from 'react';
import { ArrowRight, BellRing, Check, AlertTriangle } from 'lucide-react';
import { useApp } from '../App.tsx';
import { Avatar, BandChip, Tag } from '../components/ui.tsx';

export function Workload() {
  const { s, open, handoff } = useApp();
  const [team, setTeam] = useState('all');
  const person = (id: string) => s.people.find(p => p.id === id)!;
  const loads = s.loads.filter(l => team === 'all' || l.person.teamId === team).sort((a, b) => b.loadRatio - a.loadRatio);
  const handoffs = s.handoffs.filter(h => team === 'all' || person(h.fromId).teamId === team);
  const reminders = s.reminders.filter(r => team === 'all' || person(r.personId)?.teamId === team);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Workload</h1><p>Each person's queue is played forward in priority order at about 6 productive hours a day. Items that would miss their SLA or deadline because of the queue are flagged, and a teammate with the right skills and spare time is suggested.</p></div>
        <select className="input" value={team} onChange={e => setTeam(e.target.value)} aria-label="Team">
          <option value="all">All teams</option>{s.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div className="split even">
        <div className="card">
          <div className="card-head"><AlertTriangle size={16} color="var(--warn)" /><h2>Suggested hand-offs</h2><span className="sub">{handoffs.length} suggestions · a manager approves, nothing moves automatically</span></div>
          {!handoffs.length && <div className="empty">No hand-offs needed right now.</div>}
          {handoffs.map(h => {
            const it = s.items.find(i => i.id === h.itemId)!;
            const sc = s.scored.find(x => x.item.id === h.itemId);
            return (
              <div className="handoff" key={h.itemId}>
                <div className="grow">
                  <div className="row" style={{ cursor: 'pointer' }} onClick={() => open(it.id)}>{sc && <BandChip band={sc.band} />}<span className="mono">{it.externalId}</span><span className="ellipsis">{it.title}</span></div>
                  <div className="row small" style={{ marginTop: 6 }}>
                    <Avatar person={person(h.fromId)} /><span>{person(h.fromId).name}</span><ArrowRight size={14} /><Avatar person={person(h.toId)} /><b>{person(h.toId).name}</b>{h.crossTeam && <Tag color="orange">other team</Tag>}
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>{h.reason}</div>
                </div>
                <button className="btn primary" onClick={() => void handoff(h.itemId, h.toId)}><Check size={14} /> Approve</button>
              </div>
            );
          })}
        </div>
        <div className="card">
          <div className="card-head"><BellRing size={16} /><h2>Reminders</h2><span className="sub">red ones notify now, the rest wait for a daily digest</span></div>
          <div className="feed" style={{ maxHeight: 420, overflow: 'auto' }}>
            {reminders.slice(0, 30).map(r => (
              <div key={r.id} className="feed-item" onClick={() => r.itemId && open(r.itemId)}>
                <Avatar person={person(r.personId)} />
                <div className="grow">
                  <div className="row"><b className="small">{person(r.personId)?.name}</b><Tag color={r.severity === 'critical' ? 'red' : 'orange'}>{r.kind.replace('-', ' ')}</Tag></div>
                  <div className="small">{r.message}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="people">
        {loads.map(l => {
          const color = l.status === 'overloaded' ? 'var(--danger)' : l.status === 'busy' ? 'var(--warn)' : 'var(--ok)';
          const mine = s.scored.filter(x => x.item.assigneeId === l.person.id).slice(0, 4);
          return (
            <div className="card person-card" key={l.person.id}>
              <div className="row">
                <Avatar person={l.person} size="lg" />
                <div className="grow"><b>{l.person.name}</b><div className="small muted">{l.person.role} · {s.teams.find(t => t.id === l.person.teamId)?.name}</div></div>
                <Tag color={l.status === 'overloaded' ? 'red' : l.status === 'busy' ? 'orange' : 'green'}>{l.status}</Tag>
              </div>
              <div className="row" style={{ margin: '12px 0 6px' }}>
                <span className="big" style={{ color }}>{Math.round(l.loadRatio * 100)}%</span>
                <span className="small muted grow">{l.queuedHours} h queued vs {l.capacityHours} h left this week · {l.openItems} items · {l.atRiskItemIds.length} at risk</span>
              </div>
              <div className="loadbar" style={{ marginBottom: 12 }}><span style={{ width: `${Math.min(1.6, l.loadRatio) / 1.6 * 100}%`, background: color }} /><i className="cap" style={{ left: `${100 / 1.6}%` }} /></div>
              {mine.map(x => (
                <div key={x.item.id} className="row small" style={{ padding: '3px 0', cursor: 'pointer' }} onClick={() => open(x.item.id)}>
                  <BandChip band={x.band} /><span className="mono muted">{x.item.externalId}</span><span className="ellipsis grow">{x.item.title}</span>
                  {l.atRiskItemIds.includes(x.item.id) && <Tag color="red">at risk</Tag>}
                </div>
              ))}
              <div className="small muted" style={{ marginTop: 8 }}>Skills: {l.person.skills.join(', ')}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
