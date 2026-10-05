import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Wrench } from 'lucide-react';
import { useApp } from '../App.tsx';

const SUGGESTIONS = [
  'What is blocking the Acme go-live?',
  'Who is overloaded right now?',
  'What changed from email today?',
  'What should Marek work on first?',
  'Which tickets breach SLA in the next 24 hours?',
  'Status of INT-400',
];

export function Assistant() {
  const { s, chat, open, chatLog, setChatLog, ai } = useApp();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [chatLog.length, busy]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setQ('');
    setChatLog(l => [...l, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const a = await chat(question, chatLog.map(({ role, text }) => ({ role, text })));
      setChatLog(l => [...l, { role: 'assistant', text: a.text, answer: a }]);
    } catch (e) {
      setChatLog(l => [...l, { role: 'assistant', text: `Sorry, that failed: ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="page" style={{ paddingBottom: 16 }}>
      <div className="page-head">
        <div className="grow"><h1>Assistant</h1><p>Ask about tickets, customers, people and workload. Answers come from the live data, with links to the records. Read-only.</p></div>
      </div>
      <div className="chat">
        <div className="chat-log">
          {!chatLog.length && (
            <div className="empty">
              <Sparkles size={32} color="var(--brand)" />
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8, color: 'var(--fg)' }}>How can I help, Dana?</div>
              <div className="small">Running on {ai?.mode === 'local-llm' ? `${ai.chatModel} on this computer` : ai?.mode === 'team-hub' ? 'your team hub server' : 'the built-in rule engine (no model installed)'}.</div>
              <div className="suggestions">{SUGGESTIONS.map(x => <button key={x} onClick={() => void ask(x)}>{x}</button>)}</div>
            </div>
          )}
          {chatLog.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
              {m.answer && m.answer.refs.length > 0 && (
                <div className="refs">{m.answer.refs.slice(0, 8).map(id => {
                  const it = s.items.find(x => x.id === id)!;
                  return <button key={id} className="ref-chip" onClick={() => open(id)} title={it.title}>{it.externalId}</button>;
                })}</div>
              )}
              {m.answer && (
                <div className="meta"><Wrench size={11} />{m.answer.toolCalls.join(', ') || 'no tool'}<span>·</span>{m.answer.engine}{m.answer.latencyMs !== undefined && <><span>·</span>{(m.answer.latencyMs / 1000).toFixed(1)} s</>}</div>
              )}
            </div>
          ))}
          {busy && <div className="msg assistant typing"><span /><span /><span /></div>}
          <div ref={end} />
        </div>
        <div>
          {chatLog.length > 0 && <div className="suggestions" style={{ justifyContent: 'flex-start', margin: '0 0 10px' }}>{SUGGESTIONS.slice(0, 4).map(x => <button key={x} className="small" onClick={() => void ask(x)}>{x}</button>)}</div>}
          <form className="composer" onSubmit={e => { e.preventDefault(); void ask(q); }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Ask about any ticket, customer or person…" aria-label="Question" />
            <button className="btn primary" disabled={!q.trim() || busy}><Send size={16} /> Ask</button>
          </form>
        </div>
      </div>
    </div>
  );
}
