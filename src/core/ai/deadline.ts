// Turns the words an email uses for a deadline ("by Friday", "bis morgen früh", "do 14. října") into a date,
// counted from when the email was sent. Small models quote and translate those words well but get calendar
// arithmetic wrong, so the model only copies the words and the arithmetic happens here.
// Understands English fully, and German, Czech, Slovak, Spanish and French day, month and week words.

const DAY = 86400_000;
type Clock = [number, number];

// Words are matched without accents, so "pátku", "patku" and "PÁTKU" are the same word.
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const alt = (list: string[]) => `(?:${[...list].sort((a, b) => b.length - a.length).join('|')})`;

// Monday first.
const WEEKDAYS = [
  'monday mon montag pondeli pondelka pondelok lunes lundi',
  'tuesday tue tues dienstag utery uterka utorok utorka martes mardi',
  'wednesday wed mittwoch streda stredy stredu stredou miercoles mercredi',
  'thursday thu thur thurs donnerstag ctvrtek ctvrtka stvrtok stvrtka jueves jeudi',
  'friday fri freitag patek patku piatok piatku viernes vendredi',
  'saturday samstag sonnabend sobota soboty sobotu sabado samedi',
  'sunday sonntag nedele nedeli nedela domingo dimanche',
].map(l => l.split(' '));
const MONTHS = [
  'january jan januar janner ledna leden januara enero janvier',
  'february feb februar unora unor februara febrero fevrier',
  'march mar marz brezna brezen marca marzo mars',
  'april apr dubna duben aprila abril avril',
  'may mai kvetna kveten maja mayo',
  'june jun juni cervna cerven juna junio juin',
  'july jul juli cervence cervenec jula julio juillet',
  'august aug srpna srpen augusta agosto aout',
  'september sep sept zari septembra septiembre septembre',
  'october oct oktober rijna rijen oktobra octubre octobre',
  'november nov listopadu listopad novembra noviembre novembre',
  'december dec dezember prosince prosinec decembra diciembre decembre',
].map(l => l.split(' '));
const WEEKDAY = new RegExp(`\\b(${alt(WEEKDAYS.flat())})\\b`);
const MONTH = alt(MONTHS.flat());

const NEXT = /\b(next|following|nachste[nmrs]?|kommende[nmrs]?|pristi(?:ho|m)?|budouci(?:ho|m)?|buduc(?:i|eho|om)|proxim[oa]|que viene|prochaine?)\b/;
const END_OF_NEXT_WEEK = /\b(end of next week|ende (?:der )?nachste[nr]? woche|konc[ei] pristiho tydne|fin(?:ales)? de la proxima semana|fin de la semaine prochaine)\b/;
const NEXT_WEEK = /\b(next week|following week|nachste[nr]? woche|kommende[nr]? woche|(?:pristi|budouci)(?:ho|m)? ty(?:den|dne|dnu)|buduc(?:i|eho|om) tyzd(?:en|na|ni)|proxima semana|semana (?:que viene|proxima)|semaine prochaine)\b/;
const END_OF_WEEK = /\b(end of (?:the |this )?week|this week|by the weekend|weekend|eow|week'?s end|diese[nr]? woche|ende der woche|wochenende|konc[ei] tydne|konca tyzdna|tento tyden|tento tyzden|esta semana|finales? de (?:la |esta )?semana|cette semaine|fin de (?:la )?semaine)\b/;
const END_OF_NEXT_MONTH = /\b(end of next month|ende des nachsten monats|konc[ei] pristiho mesice)\b/;
const END_OF_MONTH = /\b(end of (?:the |this )?month|last (?:working |business )?day of (?:the |this )?month|month[- ]?end|eom|monatsende|ende (?:des|diese[ns]) monats|kon(?:ec|ce|ci) mesice|kon(?:ca|iec) mesiaca|finales? de(?:l)? mes|fin de mes|fin du mois)\b/;
const DAY_AFTER_TOMORROW = /\b(day after tomorrow|ubermorgen|pozitri|pozajtra|pasado manana|apres[- ]demain)\b/;
const TOMORROW = /\b(tomorrow|tmrw|morgen|zitra|zitrka|zajtra|manana|demain)\b/;
// Words about the past ("since Monday", "two days ago", "letzte Woche") never name a deadline.
const PAST = /\b(since|ago|last(?! (?:working |business )?day of)|yesterday|seit|gestern|letzte[nmrs]?|minul[aeyou]{1,2}|vcera|desde|ayer|depuis|hier|derniere?)\b/;
const TODAY = /\b(today|tonight|this (?:morning|afternoon|evening)|end of (?:the )?(?:business )?day|eod|cob|close of business|heute|dnes|dneska|hoy|aujourd'?hui|ce soir)\b/;

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, twelve: 12 };
const DURATION = new RegExp('\\b(?:in|within|inside|innerhalb(?: von)?|in den nachsten|do|behem|en|dentro de|sous|dans)\\s+(?:the\\s+)?(?:next\\s+)?'
  + '(\\d{1,3}|one|two|three|four|five|six|seven|eight|ten|twelve|an?)\\s*'
  + '(business days?|working days?|werktage?n?|pracovnich dn[ui]|pracovnych dni|dias habiles|jours ouvres|hours?|hrs?|h|stunden|hodin|horas|heures|days?|tage?n?|dn[ui]|dias|jours|weeks?|wochen|tydnu|semanas|semaines)\\b');
const HOURS = /^(hours?|hrs?|h|stunden|hodin|horas|heures)$/;
const WORKDAYS = /(business|working|werktag|pracovn|habiles|ouvres)/;
const WEEKS = /^(weeks?|wochen|tydnu|semanas|semaines)$/;

/** Hour and minute the phrase names, if any. */
function clock(t: string): Clock | null {
  let m = t.match(/\b(\d{1,2})\s*(?::|\.|h)\s*(\d{2})\b/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return [Number(m[1]), Number(m[2])];
  m = t.match(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/);
  if (m && Number(m[1]) <= 12) return [(Number(m[1]) % 12) + (m[2].startsWith('p') ? 12 : 0), 0];
  m = t.match(/\b(\d{1,2})\s*(?:uhr|hodin|h\b|o'?clock)/);
  if (m && Number(m[1]) < 24) return [Number(m[1]), 0];
  if (/\b(noon|midday|lunch ?time|mittags?|poledne|obed|mediodia|midi)\b/.test(t)) return [12, 0];
  if (/\b(first thing|morning|fruh|morgens|vormittag|rano|dopoledne|por la manana|matin|start of (?:the )?day)\b/.test(t)) return [9, 0];
  if (/\b(afternoon|nachmittag|odpoledne|por la tarde|apres[- ]midi)\b/.test(t)) return [15, 0];
  if (/\b(tonight|evening|abend|vecer|por la noche|soir)\b/.test(t)) return [18, 0];
  return null;
}

/** A calendar date written in the phrase, and the phrase without it. */
function writtenDate(t: string, sent: Date): { date: Date; rest: string } | null {
  const candidates: [RegExpMatchArray | null, (m: RegExpMatchArray) => [string | undefined, number, number]][] = [
    [t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/), m => [m[1], Number(m[2]) - 1, Number(m[3])]],
    [t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s*(?:of\\s+|de\\s+)?(${MONTH})\\b\\.?(?:\\s+(\\d{4}))?`)),
      m => [m[3], MONTHS.findIndex(l => l.includes(m[2])), Number(m[1])]],
    [t.match(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`)),
      m => [m[3], MONTHS.findIndex(l => l.includes(m[1])), Number(m[2])]],
    [t.match(/\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})\b)?/), m => [m[3], Number(m[2]) - 1, Number(m[1])]],
    // 14/10 is day first, as in Europe, unless that is impossible (10/14).
    [t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/),
      m => Number(m[1]) <= 12 && Number(m[2]) > 12 ? [m[3], Number(m[1]) - 1, Number(m[2])] : [m[3], Number(m[2]) - 1, Number(m[1])]],
  ];
  for (const [m, read] of candidates) {
    if (!m) continue;
    const [y, month, day] = read(m);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    const date = new Date(Date.UTC(y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : sent.getUTCFullYear(), month, day));
    // A deadline is never months in the past: a date without a year that already passed this year means next year.
    if (!y && date.getTime() < sent.getTime() - 60 * DAY) date.setUTCFullYear(date.getUTCFullYear() + 1);
    return { date, rest: t.replace(m[0], ' ') };
  }
  // "on the 14th": the next time that day of the month comes round.
  const nth = t.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth && Number(nth[1]) >= 1 && Number(nth[1]) <= 31) {
    const d = Number(nth[1]);
    const month = d >= sent.getUTCDate() ? sent.getUTCMonth() : sent.getUTCMonth() + 1;
    return { date: new Date(Date.UTC(sent.getUTCFullYear(), month, d)), rest: t.replace(nth[0], ' ') };
  }
  return null;
}

/** The deadline a short phrase names, as an ISO date-time, or null when it names no day or time. */
export function parseDeadlinePhrase(phrase: string | null | undefined, sentIso: string): string | null {
  if (!phrase?.trim()) return null;
  const sent = new Date(sentIso);
  if (Number.isNaN(sent.getTime())) return null;
  const t = ` ${plain(phrase).replace(/[“”„"«»()]/g, ' ').replace(/\s+/g, ' ')} `;
  if (PAST.test(t)) return null;
  const at = (day: Date, [h, m]: Clock) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m)).toISOString();
  const plus = (n: number) => new Date(sent.getTime() + n * DAY);
  const iso = (sent.getUTCDay() + 6) % 7;                                 // Monday 0 … Sunday 6
  const nextMonday = 7 - iso;
  const EOD: Clock = [17, 0];

  const written = writtenDate(t, sent);
  if (written) return at(written.date, clock(written.rest) ?? EOD);

  const dur = t.match(DURATION);
  if (dur) {
    const n = /^\d+$/.test(dur[1]) ? Number(dur[1]) : NUMBER_WORDS[dur[1]] ?? 1;
    if (HOURS.test(dur[2])) return new Date(sent.getTime() + n * 3600_000).toISOString();
    if (WORKDAYS.test(dur[2])) {
      let d = sent;
      for (let left = n; left > 0;) { d = new Date(d.getTime() + DAY); if (d.getUTCDay() % 6 !== 0) left--; }
      return at(d, clock(t) ?? EOD);
    }
    return at(plus(WEEKS.test(dur[2]) ? 7 * n : n), clock(t) ?? EOD);
  }

  const wd = t.match(WEEKDAY);
  const weekday = wd ? WEEKDAYS.findIndex(l => l.includes(wd[1])) : -1;
  if (DAY_AFTER_TOMORROW.test(t)) return at(plus(2), clock(t) ?? EOD);
  if (END_OF_NEXT_WEEK.test(t)) return at(plus(nextMonday + 4), clock(t) ?? EOD);
  if (NEXT_WEEK.test(t)) return at(plus(nextMonday + Math.max(weekday, 0)), clock(t) ?? (weekday >= 0 ? EOD : [9, 0]));
  if (weekday >= 0) {
    // "Friday" is the coming Friday (a week ahead if sent on a Friday); "next Friday" is Friday next week.
    const ahead = NEXT.test(t) ? nextMonday + weekday : ((weekday - iso + 7) % 7) || (/\b(this|today|heute|dnes|hoy)\b/.test(t) ? 0 : 7);
    return at(plus(ahead), clock(t) ?? EOD);
  }
  // German "morgen" is tomorrow, but "heute Morgen" is this morning; Spanish "mañana" is both too.
  if (TOMORROW.test(t) && !/\b(heute|hoy)\b/.test(t)) return at(plus(1), clock(t.replace(/\bmorgen\b/, ' ')) ?? EOD);
  if (TODAY.test(t)) return at(sent, clock(t) ?? EOD);
  if (END_OF_WEEK.test(t)) return at(plus(iso <= 4 ? 4 - iso : 11 - iso), clock(t) ?? EOD);
  if (END_OF_NEXT_MONTH.test(t)) return at(new Date(Date.UTC(sent.getUTCFullYear(), sent.getUTCMonth() + 2, 0)), clock(t) ?? EOD);
  if (END_OF_MONTH.test(t)) return at(new Date(Date.UTC(sent.getUTCFullYear(), sent.getUTCMonth() + 1, 0)), clock(t) ?? EOD);

  // Only a time ("by 3 pm", "before noon"): today, or tomorrow if that time has already passed.
  const c = clock(t);
  if (c) {
    const today = at(sent, c);
    return Date.parse(today) > sent.getTime() ? today : at(plus(1), c);
  }
  return null;
}
