import { Download } from 'lucide-react';
import { useApp } from '../App.tsx';
import { Tag, fmtDate } from '../components/ui.tsx';
import { pressable } from '../components/insight.tsx';

const KIND: Record<string, { label: string; color?: 'red' | 'orange' | 'green' | 'blue' | 'purple' }> = {
  'ai-signal': { label: 'AI read email', color: 'purple' },
  'priority-change': { label: 'Priority change', color: 'orange' },
  'handoff-applied': { label: 'Hand-off approved', color: 'green' },
  'weights-changed': { label: 'Weights changed', color: 'blue' },
  'injection-blocked': { label: 'Injection blocked', color: 'red' },
  'manual-override': { label: 'Manager override', color: 'blue' },
};

function csv(rows: string[][]) {
  return rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

export function Audit() {
  const { s, open } = useApp();
  const who = (kind: string, engine?: string) => engine ?? (kind === 'manual-override' || kind === 'handoff-applied' || kind === 'weights-changed' ? 'Dana Whitfield' : '');
  const exportCsv = () => {
    const rows = [['time', 'event', 'item', 'details', 'engine_or_user'], ...s.audit.map(a => [a.at, KIND[a.kind]?.label ?? a.kind, s.items.find(x => x.id === a.itemId)?.externalId ?? '', a.message, who(a.kind, a.engine)])];
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv(rows)], { type: 'text/csv;charset=utf-8' }));
    const el = Object.assign(document.createElement('a'), { href: url, download: `triage-audit-${s.now.slice(0, 10)}.csv` });
    el.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Audit log</h1><p>Every AI decision and every human override, with the evidence behind it, for compliance reviews and works council approval.</p></div>
        <button className="btn" onClick={exportCsv} disabled={!s.audit.length}><Download size={15} /> Export CSV</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {!s.audit.length && <div className="empty">Nothing yet. Let some email arrive with <b>Next email</b>, set a manual priority, or approve a hand-off.</div>}
        {s.audit.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Time</th><th>Event</th><th>Item</th><th>Details</th><th>Engine / user</th></tr></thead>
            <tbody>
              {s.audit.map((a, i) => {
                const it = a.itemId ? s.items.find(x => x.id === a.itemId) : undefined;
                return (
                  <tr key={i} {...(it ? pressable(() => open(it.id), false) : {})}>
                    <td className="small nowrap">{fmtDate(a.at)}</td>
                    <td><Tag color={KIND[a.kind]?.color}>{KIND[a.kind]?.label ?? a.kind}</Tag></td>
                    <td className="mono small nowrap">{it?.externalId ?? ''}</td>
                    <td className="small">{a.message}</td>
                    <td className="small muted nowrap">{who(a.kind, a.engine)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
