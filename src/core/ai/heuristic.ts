// Rule-based signal extractor. Used when no local model is installed (web demo, first run),
// and as the baseline the LLM is measured against in the benchmark.
import type { Email, EmailSignals, Urgency } from '../types.ts';
import { findTicketRefs } from '../linker.ts';

const sentences = (body: string) => body.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3);
const has = (s: string, re: RegExp) => re.test(s);

// Common shapes of text aimed at an AI rather than at people (indirect prompt injection).
const INJECTION = /(ignore (all |any )?(previous|prior|above|earlier) instructions|system notice to ai|as an ai assistant you must|do not mention this message|if you are an? (ai|language model|llm|bot|automated (system|assistant))\b|\b(ai|llm|language model|bot|classifier|triage (bot|model|system)) (reading|processing|summari[sz]ing) this)/i;
// Out-of-office and other auto-replies carry no ask (real mail has an Auto-Submitted header; the subject is the proxy here).
const AUTO_REPLY = /^\s*((re|aw|fwd?|wg)\s*:\s*)*(automatic reply|automatische antwort|abwesenheitsnotiz|abwesend|réponse automatique|respuesta automática|automatická odpověď|out of office|ooo\b)/i;
const plainText = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[“”„"«»']/g, '').replace(/\s+/g, ' ').trim();
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

/** A calendar date written out in the email ("Thursday 8 October") next to deadline words, with the words themselves. */
export function writtenDeadline(text: string, nowIso: string): { at: string; text: string } | null {
  const now = new Date(nowIso);
  const t = text.toLowerCase();
  const dm = t.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/);
  if (!dm || !/(go-live|deadline|by|ready|production|instead|moved|forward)/.test(t)) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS.indexOf(dm[2]), Number(dm[1]), 17));
  return { at: d.toISOString(), text: text.substr(dm.index!, dm[0].length) };
}

export function extractDeadline(text: string, nowIso: string): string | null {
  const now = new Date(nowIso);
  const t = text.toLowerCase();
  const written = writtenDeadline(text, nowIso);
  if (written) return written.at;
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
  if ((NOISE_SENDER.test(e.from) || AUTO_REPLY.test(e.subject))) return { ...base, summary: `Internal or bulk mail: ${e.subject}` };

  let urgency: Urgency = 'low';
  let evidence = '';
  const pickEvidence = (re: RegExp) => evidence ||= sents.find(s => re.test(s)) ?? '';
  const exec = EXEC.test(withoutSignature(e.body));
  if (has(text, CRITICAL)) { urgency = 'critical'; pickEvidence(CRITICAL); }
  else if (has(text, HIGH)) { urgency = 'high'; pickEvidence(HIGH); }
  else if (has(text, MEDIUM)) { urgency = 'medium'; pickEvidence(MEDIUM); }
  if (exec && (urgency === 'high' || urgency === 'medium')) urgency = urgency === 'high' ? 'critical' : 'high';
  const deadline = extractDeadline(e.body, e.receivedAt);   // "by tomorrow" counts from when the email was sent
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

const REF_SHAPE = /^(1-[A-Z0-9]{6}|[A-Z]{2,6}-\d{2,6})$/;

/** Rule safety net around a model's answer: injection patterns the rules know always quarantine the email,
 *  ticket ids must literally appear in the email (a model cannot link mail to a ticket it imagined), and
 *  a deadline or de-escalation the rules find is kept when the model missed it. */
export function combineWithRules(model: EmailSignals, e: Email, nowIso: string): EmailSignals {
  const rules = heuristicSignals(e, nowIso);
  const text = `${e.subject}\n${e.body}`.toUpperCase();
  const ticketRefs = [...new Set([...rules.ticketRefs, ...model.ticketRefs.map(r => r.trim().toUpperCase()).filter(r => REF_SHAPE.test(r) && text.includes(r))])];
  if (model.suspiciousInstructions || rules.suspiciousInstructions) {
    return { ...model, ticketRefs, suspiciousInstructions: true, isEscalation: false, isDeescalation: false, urgency: 'none', deadline: null, deadlineText: undefined,
      evidence: model.suspiciousInstructions ? model.evidence : rules.evidence, summary: model.suspiciousInstructions ? model.summary : rules.summary };
  }
  // A deadline counts only when the words the model quoted are really in the email (not copied from its instructions)
  // and the mail asks for something: a newsletter's "Friday" or a meeting's "tomorrow" is a mention, not an ask.
  // The 2B model often leaves urgency at "none" even on an escalation, so any of the three signals is enough.
  // Auto-replies never escalate and their dates ("back on 12 October") are not deadlines.
  const autoReply = AUTO_REPLY.test(e.subject);
  const quoted = !model.deadlineText || plainText(`${e.subject}\n${e.body}`).includes(plainText(model.deadlineText));
  const asks = model.isEscalation || model.urgency !== 'none' || model.customerImpact !== 'none';
  const fromModel = !autoReply && quoted && asks ? model.deadline : null;
  // When the model quoted a relative phrase ("confirm by end of day today") while the email also writes out a
  // calendar date ("go-live on Thursday 8 October"), the written date is the real commitment.
  const written = fromModel ? writtenDeadline(e.body, e.receivedAt) : null;
  const deadline = written?.at ?? fromModel ?? (autoReply ? null : rules.deadline);
  const deadlineText = !deadline ? undefined : written ? written.text : deadline === fromModel ? model.deadlineText : undefined;
  return { ...model, ticketRefs, deadline, deadlineText, isEscalation: model.isEscalation && !autoReply,
    isDeescalation: model.isDeescalation || (rules.isDeescalation && !model.isEscalation) };
}
