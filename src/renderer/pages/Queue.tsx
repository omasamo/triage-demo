import { useEffect, useMemo, useState } from 'react';
import { Pin, Sparkles } from 'lucide-react';
import { useApp } from '../App.tsx';
import { Avatar, BandChip, ScoreBar, SourceBadge, Tag, Tier, slaText } from '../components/ui.tsx';

const SHORT: Record<string, string> = { escalation: 'Escalated', deadline: 'Deadline', executive: 'Exec', deescalation: 'Calmed' };

export function Queue() {
  const { s, open, flash, routeOpts } = useApp();
  const [team, setTeam] = useState('all');
  const [source, setSource] = useState('all');
  const [band, setBand] = useState(routeOpts.filter?.band ?? 'all');
  const [due, setDue] = useState(routeOpts.filter?.due ?? 'all');
  const [text, setText] = useState('');
  useEffect(() => { setBand(routeOpts.filter?.band ?? 'all'); setDue(routeOpts.filter?.due ?? 'all'); }, [routeOpts]);
  const now = Date.parse(s.now);

  const rows = useMemo(() => s.scored.filter(x =>
    (team === 'all' || x.item.teamId === team) && (source === 'all' || x.item.source === source) && (band === 'all' || x.band === band)
    && (due === 'all' || (x.item.status !== 'Waiting on Customer' && Date.parse(x.item.slaDueAt) - now < 24 * 3600_000))
    && (!text || `${x.item.externalId} ${x.item.title} ${s.customers.find(c => c.id === x.item.customerId)?.name}`.toLowerCase().includes(text.toLowerCase()))),
  [s, team, source, band, due, text]);
  const person = (id: string) => s.people.find(p => p.id === id);
  const customer = (id: string) => s.customers.find(c => c.id === id);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Priority queue</h1><p>One ranked list across Siebel service requests and Jira issues. Click any row to see why it ranks there.</p></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: 12, borderBottom: '1px solid var(--stroke)', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Filter by id, title or customer" value={text} onChange={e => setText(e.target.value)} style={{ width: 260 }} />
          <select className="input" value={team} onChange={e => setTeam(e.target.value)} aria-label="Team">
            <option value="all">All teams</option>{s.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="seg">
            {['all', 'siebel', 'jira'].map(v => <button key={v} className={source === v ? 'on' : ''} onClick={() => setSource(v)}>{v === 'all' ? 'All sources' : v === 'siebel' ? 'Siebel' : 'Jira'}</button>)}
          </div>
          <div className="seg">
            {['all', 'P1', 'P2', 'P3', 'P4'].map(v => <button key={v} className={band === v ? 'on' : ''} onClick={() => setBand(v)}>{v === 'all' ? 'Any priority' : v}</button>)}
          </div>
          <button className={`btn ${due === '24h' ? 'primary' : ''}`} onClick={() => setDue(d => d === '24h' ? 'all' : '24h')}>SLA due in 24 h</button>
          <span className="grow" /><span className="small muted">{rows.length} items</span>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 230px)', overflow: 'auto' }}>
          <table className="table">
            <thead><tr><th style={{ width: 40 }}>#</th><th>Priority</th><th>Item</th><th>Owner</th><th>Status</th><th>SLA</th><th>Score</th><th>Email signals</th></tr></thead>
            <tbody>
              {rows.map((x, i) => {
                const sla = slaText(x.item.slaDueAt, s.now);
                const ai = x.factors.filter(f => ['escalation', 'deadline', 'executive', 'deescalation'].includes(f.key));
                return (
                  <tr key={x.item.id} onClick={() => open(x.item.id)} className={flash.has(x.item.id) ? 'flash' : ''}>
                    <td className="muted small">{i + 1}</td>
                    <td><div className="row" style={{ gap: 4 }}><BandChip band={x.band} />{x.override && <span title={`Set by ${x.override.by}: ${x.override.reason}`}><Pin size={13} color="var(--brand)" /></span>}</div></td>
                    <td className="title-cell"><div className="row small"><SourceBadge source={x.item.source} /><span className="mono muted">{x.item.externalId}</span><span className="muted">· {customer(x.item.customerId)?.name}</span><Tier c={customer(x.item.customerId)} /></div><div className="ellipsis" style={{ maxWidth: 420 }}>{x.item.title}</div></td>
                    <td><div className="row small"><Avatar person={person(x.item.assigneeId)} /><span className="nowrap">{person(x.item.assigneeId)?.name.split(' ')[0]}</span></div></td>
                    <td className="small nowrap">{x.item.status}</td>
                    <td><Tag color={sla.cls}>{sla.text}</Tag></td>
                    <td><div className="row"><ScoreBar s={x} /><b className="small">{x.score}</b></div></td>
                    <td><div className="row" style={{ gap: 4 }}>{ai.slice(0, 2).map(f => <Tag key={f.key} color={f.key === 'deescalation' ? 'green' : 'purple'} title={f.detail}><Sparkles size={10} />{SHORT[f.key]}</Tag>)}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <div className="empty">No items match these filters.</div>}
        </div>
      </div>
    </div>
  );
}
