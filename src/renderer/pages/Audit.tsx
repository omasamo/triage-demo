import { useApp } from '../App.tsx';
import { Tag, fmtDate } from '../components/ui.tsx';

const KIND: Record<string, { label: string; color?: 'red' | 'orange' | 'green' | 'blue' | 'purple' }> = {
  'ai-signal': { label: 'AI read email', color: 'purple' },
  'priority-change': { label: 'Priority change', color: 'orange' },
  'handoff-applied': { label: 'Hand-off approved', color: 'green' },
  'weights-changed': { label: 'Weights changed', color: 'blue' },
  'injection-blocked': { label: 'Injection blocked', color: 'red' },
  'manual-override': { label: 'Manager override', color: 'blue' },
};

export function Audit() {
  const { s, open } = useApp();
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>Audit log</h1><p>Every AI decision and every human override, with the evidence behind it. Exportable for compliance reviews and works council approval.</p></div></div>
      <div className="card" style={{ padding: 0 }}>
        {!s.audit.length && <div className="empty">Nothing yet. Let some email arrive with <b>Next email</b>, set a manual priority, or approve a hand-off.</div>}
        {s.audit.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Time</th><th>Event</th><th>Item</th><th>Details</th><th>Engine / user</th></tr></thead>
            <tbody>
              {s.audit.map((a, i) => {
                const it = a.itemId ? s.items.find(x => x.id === a.itemId) : undefined;
                return (
                  <tr key={i} onClick={() => it && open(it.id)}>
                    <td className="small nowrap">{fmtDate(a.at)}</td>
                    <td><Tag color={KIND[a.kind]?.color}>{KIND[a.kind]?.label ?? a.kind}</Tag></td>
                    <td className="mono small">{it?.externalId ?? ''}</td>
                    <td className="small">{a.message}</td>
                    <td className="small muted nowrap">{a.engine ?? (a.kind === 'manual-override' || a.kind === 'handoff-applied' || a.kind === 'weights-changed' ? 'Dana Whitfield' : '')}</td>
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
