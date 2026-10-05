import { useEffect, useState } from 'react';
import { Cpu, Server, ShieldCheck, SlidersHorizontal, Plug, RefreshCw } from 'lucide-react';
import { useApp } from '../App.tsx';
import type { DesktopSettings } from '../api.ts';
import type { AiConfig } from '../../node/config.ts';
import type { Weights } from '../../core/types.ts';
import { FACTOR_LABELS, DEFAULT_WEIGHTS } from '../../core/scoring.ts';
import { Tag } from '../components/ui.tsx';

export function Settings() {
  const { s, ai, api, setWeights, refreshAi, toast } = useApp();
  const [ds, setDs] = useState<DesktopSettings | null>(null);
  const [draft, setDraft] = useState<AiConfig | null>(null);
  const [progress, setProgress] = useState<string>('');
  useEffect(() => { void api.settings?.().then(d => { setDs(d); setDraft(d.config); }); }, [api]);
  useEffect(() => api.on?.('reanalyse-progress', p => { const x = p as { done: number; total: number }; setProgress(`${x.done} / ${x.total}`); }), [api]);

  const save = async () => {
    if (!draft || !api.saveSettings) return;
    const d = await api.saveSettings(draft); setDs(d); setDraft(d.config);
    toast({ kind: 'ok', title: 'AI settings saved', body: 'Reconnecting the AI engine.' });
    setTimeout(() => void refreshAi(), 1500);
  };
  const reanalyse = async () => {
    if (!api.reanalyse) return;
    setProgress('starting…');
    const r = await api.reanalyse();
    setProgress(r.error ? r.error : `Done: ${r.done} emails re-read by the model`);
  };

  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>Settings</h1><p>AI engine, scoring weights and data sources.</p></div></div>
      <div className="settings">
        <div className="card">
          <div className="card-head"><Cpu size={16} /><h2>AI engine</h2><span className="grow" /><Tag color={ai?.mode === 'rules' ? 'orange' : 'green'}>{ai?.mode === 'local-llm' ? 'Local model' : ai?.mode === 'team-hub' ? 'Team hub' : 'Rule engine'}</Tag></div>
          <div className="small muted" style={{ marginBottom: 12 }}>{ai?.message}{ai?.device ? ` · ${ai.device}` : ''}</div>
          {!ds || !draft ? (
            <div className="banner info small">
              <div>This is the web demo, so the AI runs as a rule engine inside your browser. The desktop app for Mac and Windows runs <b>Qwen3.5-2B</b> on the laptop itself (about 1.5 GB, works on any 8 GB machine), with <b>Qwen3.5-4B</b> as an option on 16 GB machines, or connects to a model on a company server. Installers are on the <a href="https://github.com/omasamo/triage-demo/releases" target="_blank" rel="noreferrer">Releases page</a>.</div>
            </div>
          ) : (
            <div className="col" style={{ gap: 12 }}>
              <div className="small muted">This computer: {ds.hardware.platform}, {ds.hardware.ramGb} GB RAM, {ds.hardware.cores} cores</div>
              {([
                ['auto', 'Automatic', 'Use the local model if it is installed, otherwise the rule engine.'],
                ['local', 'Local model only', 'Everything runs on this computer. No data leaves it.'],
                ['server', 'Team hub server', 'Use a model on a company server (OpenAI-compatible: llama.cpp server, vLLM, Ollama). For thin laptops or large teams.'],
                ['rules', 'Rule engine only', 'No AI model. Keyword rules only; useful as a baseline.'],
              ] as const).map(([v, t, d]) => (
                <label key={v} className={`option ${draft.mode === v ? 'on' : ''}`}>
                  <input type="radio" name="mode" checked={draft.mode === v} onChange={() => setDraft({ ...draft, mode: v })} />
                  <div><b>{t}</b><div className="small muted">{d}</div></div>
                </label>
              ))}
              {(draft.mode === 'auto' || draft.mode === 'local') && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Chat model</div>
                  <div className="seg">
                    <button className={draft.chatModel === 'small' ? 'on' : ''} onClick={() => setDraft({ ...draft, chatModel: 'small' })}>Qwen3.5-2B (any laptop)</button>
                    <button className={draft.chatModel === 'large' ? 'on' : ''} onClick={() => setDraft({ ...draft, chatModel: 'large' })}>Qwen3.5-4B (better answers)</button>
                  </div>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    {ds.hardware.recommendedChat === 'large' ? `Recommended: 4B. This computer has ${ds.hardware.ramGb} GB RAM.` : `Recommended: 2B. The 4B model needs 16 GB RAM; this computer has ${ds.hardware.ramGb} GB.`}
                    {' '}Email triage always uses the 2B model. Models live in <span className="mono">{ds.modelsDir}</span>.
                  </div>
                </div>
              )}
              {draft.mode === 'server' && (
                <div className="col">
                  <input className="input" placeholder="https://ai-hub.company.local/v1" value={draft.server.url} onChange={e => setDraft({ ...draft, server: { ...draft.server, url: e.target.value } })} />
                  <div className="row">
                    <input className="input grow" placeholder="Model name, e.g. qwen3.5-9b" value={draft.server.model} onChange={e => setDraft({ ...draft, server: { ...draft.server, model: e.target.value } })} />
                    <input className="input grow" type="password" placeholder="API key (optional)" value={draft.server.apiKey} onChange={e => setDraft({ ...draft, server: { ...draft.server, apiKey: e.target.value } })} />
                  </div>
                </div>
              )}
              <div className="row">
                <button className="btn primary" onClick={() => void save()}>Save and reconnect</button>
                {ai?.mode !== 'rules' && <button className="btn" onClick={() => void reanalyse()}><RefreshCw size={14} /> Re-read mailbox history with the model</button>}
                <span className="small muted">{progress}</span>
              </div>
              <div className="small muted">Local store: {ds.store}</div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><SlidersHorizontal size={16} /><h2>Scoring weights</h2><span className="grow" />
            <button className="btn sm subtle" onClick={() => void setWeights(DEFAULT_WEIGHTS)}>Reset</button></div>
          <div className="small muted" style={{ marginBottom: 8 }}>Each priority score is a sum of these factors. Tune how much each one counts for your organisation; the queue re-ranks instantly and the change is logged.</div>
          {(Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[]).map(k => (
            <div className="weight" key={k}>
              <span className="small">{FACTOR_LABELS[k]}</span>
              <input type="range" min={0} max={2} step={0.25} value={s.weights[k]} onChange={e => void setWeights({ [k]: Number(e.target.value) })} aria-label={FACTOR_LABELS[k]} />
              <span className="small mono">×{s.weights[k]}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head"><Plug size={16} /><h2>Data sources</h2><span className="sub">read-only</span></div>
          {[
            ['S', 'var(--siebel)', 'Siebel CRM', 'Service requests via Siebel REST API, polled on Last Updated', s.items.filter(i => i.source === 'siebel').length + ' service requests'],
            ['J', 'var(--jira)', 'Jira', 'Issues via REST + JQL; webhooks in team hub mode', s.items.filter(i => i.source === 'jira').length + ' issues'],
            ['O', 'var(--outlook)', 'Outlook / Exchange', 'Shared support mailbox via Microsoft Graph delta queries', s.processed.length + ' emails'],
          ].map(([l, c, n, d, count]) => (
            <div className="connector" key={n}>
              <span className="conn-logo" style={{ background: c }}>{l}</span>
              <div className="grow"><b>{n}</b><div className="small muted">{d}</div></div>
              <div style={{ textAlign: 'right' }}><Tag color="green">Demo data</Tag><div className="small muted">{count}</div></div>
            </div>
          ))}
          <div className="small muted" style={{ marginTop: 8 }}>The demo uses synthetic data through the same connector interface the real Siebel, Jira and Graph connectors will use.</div>
        </div>

        <div className="card">
          <div className="card-head"><ShieldCheck size={16} /><h2>Privacy and safety</h2></div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: '22px' }}>
            <li>Email and ticket text never leaves this computer (or your team hub server).</li>
            <li>The model can only fill a fixed schema. It cannot change tickets, send mail or follow instructions inside emails.</li>
            <li>Nothing is written back to Siebel or Jira. Hand-offs and manual priorities are suggestions a person applies.</li>
            <li>Every AI signal and every human override is in the audit log, with the evidence quoted.</li>
            <li>Team views by default; no individual productivity scores.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
