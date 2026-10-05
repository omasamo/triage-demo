// Rule-based signal extractor. Used when no local model is installed (web demo, first run),
// and as the baseline the LLM is measured against in the benchmark.
import type { Email, EmailSignals, Urgency } from '../types.ts';
import { findTicketRefs } from '../linker.ts';

const sentences = (body: string) => body.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3);
const has = (s: string, re: RegExp) => re.test(s);

const INJECTION = /(ignore (all )?(previous|prior) instructions|system notice to ai|as an ai assistant you must|do not mention this message)/i;
const NOISE_SENDER = /(newsletter|noreply|no-reply|calendar|hr@|facilities|events@|it-news|security@)/i;
const EXEC = /\b(CEO|CFO|COO|CIO|board|finance director|managing director|VP)\b/;
const CRITICAL = /(production is (effectively )?down|outage|cannot go live|regulator|penalty|top priority|treat .* as critical|refusing to pay|legal)/i;
const HIGH = /(urgent|escalat|asap|blocking our|unacceptable|third time|cannot wait|fixed today|month-end)/i;
const MEDIUM = /(any update|eta|still see|need .* (earlier|by)|instead of)/i;
const DEESC = /(no rush|no longer urgent|can log in again|works? again|resolved|workaround works|can follow in the normal release|good news)/i;
const ANGRY = /(unacceptable|refusing|third time|heard nothing)/i;
const FRUSTRATED = /(still|again|any update|following up|cannot wait)/i;
const POSITIVE = /(thanks for the quick|good news|great|works now)/i;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function extractDeadline(text: string, nowIso: string): string | null {
  const now = new Date(nowIso);
  const t = text.toLowerCase();
  // "Thursday 8 October" / "8 October"
  const dm = t.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/);
  if (dm) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS.indexOf(dm[2]), Number(dm[1]), 17));
    if (/(go-live|deadline|by|ready|production|instead|moved|forward)/.test(t)) return d.toISOString();
  }
  const tm = t.match(/by tomorrow(?:\s+(\d{1,2})[:.](\d{2}))?/);
  if (tm) {
    const d = new Date(now.getTime() + 86400_000);
    d.setUTCHours(tm[1] ? Number(tm[1]) : 17, tm[2] ? Number(tm[2]) : 0, 0, 0);
    return d.toISOString();
  }
  if (/(fixed|done|ready) today|by end of day|by eod/.test(t)) {
    const d = new Date(now); d.setUTCHours(18, 0, 0, 0); return d.toISOString();
  }
  const wm = t.match(/(?:by|on|until|to)\s+(monday|tuesday|wednesday|thursday|friday)/);
  if (wm) {
    const target = WEEKDAYS.indexOf(wm[1]);
    const diff = (target - now.getUTCDay() + 7) % 7 || 7;
    const d = new Date(now.getTime() + diff * 86400_000); d.setUTCHours(17, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

function withoutSignature(body: string) {
  const blocks = body.split(/\n\s*\n/);
  const last = blocks[blocks.length - 1];
  return blocks.length > 1 && last.split('\n').length <= 3 && last.length < 90 ? blocks.slice(0, -1).join('\n\n') : body;
}

export function heuristicSignals(e: Email, nowIso: string): EmailSignals {
  const text = `${e.subject}\n${e.body}`;
  const sents = sentences(e.body);
  const base: EmailSignals = {
    ticketRefs: findTicketRefs(text), isEscalation: false, isDeescalation: false, urgency: 'none', deadline: null,
    customerImpact: 'none', sentiment: 'neutral', executiveInvolved: false, evidence: '', summary: e.subject, suspiciousInstructions: false,
  };
  if (INJECTION.test(text)) {
    return { ...base, suspiciousInstructions: true, evidence: sents.find(s => INJECTION.test(s)) ?? sents[0] ?? '', summary: 'Email tries to instruct the AI; ignored' };
  }
  if (NOISE_SENDER.test(e.from)) return { ...base, summary: `Internal or bulk mail: ${e.subject}` };

  let urgency: Urgency = 'low';
  let evidence = '';
  const pickEvidence = (re: RegExp) => evidence ||= sents.find(s => re.test(s)) ?? '';
  const exec = EXEC.test(withoutSignature(e.body));
  if (has(text, CRITICAL)) { urgency = 'critical'; pickEvidence(CRITICAL); }
  else if (has(text, HIGH)) { urgency = 'high'; pickEvidence(HIGH); }
  else if (has(text, MEDIUM)) { urgency = 'medium'; pickEvidence(MEDIUM); }
  if (exec && (urgency === 'high' || urgency === 'medium')) urgency = urgency === 'high' ? 'critical' : 'high';
  const deadline = extractDeadline(e.body, nowIso);
  if (deadline && urgency === 'low') urgency = 'medium';
  const deesc = DEESC.test(text) && !CRITICAL.test(text);
  if (deesc) { urgency = 'low'; evidence = sents.find(s => DEESC.test(s)) ?? evidence; }

  const sentiment = ANGRY.test(text) ? 'angry' : POSITIVE.test(text) ? 'positive' : FRUSTRATED.test(text) ? 'frustrated' : 'neutral';
  const impact = /(\d[\d,]* customers|whole|all our|production|go-live|cannot go live|board)/i.test(text) ? 'business_critical'
    : /(team|several|users)/i.test(text) ? 'team' : 'single_user';
  const isEscalation = !deesc && (urgency === 'high' || urgency === 'critical');
  if (!evidence) evidence = sents.find(s => !/^(hi|hello|dear)\b/i.test(s)) ?? '';
  return {
    ...base, isEscalation, isDeescalation: deesc, urgency, deadline, customerImpact: impact, sentiment,
    executiveInvolved: exec && isEscalation, evidence: evidence.slice(0, 300),
    summary: isEscalation ? `Escalation: ${evidence.slice(0, 90)}` : deesc ? `De-escalation: ${evidence.slice(0, 90)}` : e.subject,
  };
}
