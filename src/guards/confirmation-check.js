import { localParts } from '../time.js';
import { mentionedProviders } from './availability-grounding.js';
import { dateMatches, extractDates, extractTimes, splitClauses, WORD_END, WORD_START } from './text-extract.js';

const re = (source) => new RegExp(source.normalize('NFC'), 'u');

// Spanish building blocks. \w and \b don't know accented letters, so Spanish
// patterns use these instead.
const S = WORD_START;
const E = WORD_END;
const W = '\\p{L}+';
// A word that isn't a future or conditional verb: "su cita quedará confirmada" is a promise.
const NOT_FUTURE = `(?!(?:quedar|ser|estar)[aá]${E})`;
// What a booking is called.
const BOOKING_ES = 'cita|reserva|consulta|turno|visita';

// Phrases that tell the patient a change has happened. A bare keyword search would
// also block honest replies such as "that slot was just booked by someone else", so
// these match assertions, and NEGATED below excuses the ones that deny it.
const CLAIMS = [
  {
    kind: 'booked',
    patterns: [
      "\\b(?:is|are|was|were|it'?s|that'?s|has been|have been|been|now|successfully|you'?re|you are|i'?ve|i have|we'?ve|we have)\\s+(?:\\w+\\s+)?(?:booked|confirmed|scheduled|reserved)\\b",
      '\\b(?:appointment|booking|reservation|visit)\\s+(?:is\\s+)?(?:\\w+\\s+)?(?:confirmed|booked|complete|completed|done|made)\\b',
      '\\b(?:i|we)\\s+(?:just\\s+|already\\s+)?(?:booked|confirmed|scheduled|reserved)\\b',
      '\\b(?:booked|confirmed|scheduled|reserved)\\s+(?:you|your)\\b',
      '^(?:booked|confirmed)\\b',
      'বুক করা হয়েছে|বুক করে দিয়েছি|বুক করেছি|বুক হয়েছে|বুক করে দেওয়া হয়েছে',
      'বুকিং সম্পন্ন|বুকিং নিশ্চিত|অ্যাপয়েন্টমেন্ট নিশ্চিত|অ্যাপয়েন্টমেন্ট কনফার্ম|অ্যাপয়েন্টমেন্ট ঠিক',
      'নিশ্চিত করা হয়েছে|নিশ্চিত হয়েছে|নিশ্চিত করেছি|নিশ্চিত করে দিয়েছি',
      'কনফার্ম করা হয়েছে|কনফার্ম হয়েছে|কনফার্ম করেছি|কনফার্ম করে দিয়েছি|কনফার্মড',
      // Spanish: "está confirmada", "ha quedado reservada", "le he reservado", "le reservé".
      `${S}(?:est[aá]n?|quedan?|qued[oó]|ha\\s+quedado|han\\s+quedado|fue|fueron|ha\\s+sido|han\\s+sido|ya)\\s+(?:${W}\\s+)?(?:reservad|confirmad|agendad|programad)[oa]s?${E}`,
      `${S}(?:he|hemos|se\\s+ha|se\\s+han)\\s+(?:${W}\\s+)?(?:reservado|confirmado|agendado|programado)${E}`,
      `${S}(?:${BOOKING_ES})\\s+(?:${NOT_FUTURE}${W}\\s+){0,3}(?:confirmad|reservad|agendad|programad|hech|list|completad)[oa]s?${E}`,
      `${S}(?:le|lo|la|les|ya)\\s+(?:reservé|confirmé|agendé|programé)${E}`,
      `^[¡¿]?\\s*(?:reservad|confirmad)[oa]s?${E}`,
    ],
  },
  {
    kind: 'rescheduled',
    patterns: [
      "\\b(?:is|was|it'?s|has been|have been|been|now|successfully|i'?ve|i have|we'?ve|we have|i|we)\\s+(?:\\w+\\s+)?(?:rescheduled|moved|changed)\\b",
      '\\b(?:appointment|booking)\\s+(?:is\\s+)?(?:\\w+\\s+)?(?:rescheduled|moved)\\b',
      'পরিবর্তন করা হয়েছে|পরিবর্তন করেছি|পরিবর্তন হয়েছে|পরিবর্তন করে দিয়েছি|সরিয়ে দিয়েছি|সরানো হয়েছে',
      'রিশিডিউল করা হয়েছে|রিশিডিউল করেছি|রিশিডিউল হয়েছে',
      `${S}(?:est[aá]|queda|qued[oó]|ha\\s+quedado|fue|ha\\s+sido)\\s+(?:${W}\\s+)?(?:reprogramad|cambiad|movid|trasladad|modificad)[oa]s?${E}`,
      `${S}(?:he|hemos|se\\s+ha)\\s+(?:${W}\\s+)?(?:reprogramado|cambiado|movido|trasladado|modificado|pasado)${E}`,
      `${S}(?:${BOOKING_ES})\\s+(?:${NOT_FUTURE}${W}\\s+){0,3}(?:reprogramad|cambiad|movid|trasladad|modificad)[oa]s?${E}`,
      `${S}(?:le|lo|la|ya)\\s+(?:cambié|moví|reprogramé|trasladé|pasé)${E}`,
    ],
  },
  {
    kind: 'cancelled',
    patterns: [
      "\\b(?:is|was|it'?s|has been|have been|been|now|successfully|i'?ve|i have|we'?ve|we have|i|we)\\s+(?:\\w+\\s+)?cancell?ed\\b",
      '\\b(?:appointment|booking)\\s+(?:is\\s+)?(?:\\w+\\s+)?cancell?ed\\b',
      'বাতিল করা হয়েছে|বাতিল করেছি|বাতিল হয়েছে|বাতিল করে দিয়েছি',
      'ক্যানসেল করা হয়েছে|ক্যান্সেল করা হয়েছে|ক্যানসেল করেছি|ক্যান্সেল করেছি',
      `${S}(?:est[aá]n?|queda|qued[oó]|ha\\s+quedado|fue|ha\\s+sido|han\\s+sido)\\s+(?:${W}\\s+)?(?:cancelad|anulad)[oa]s?${E}`,
      `${S}(?:he|hemos|se\\s+ha|se\\s+han)\\s+(?:${W}\\s+)?(?:cancelado|anulado)${E}`,
      `${S}(?:${BOOKING_ES})\\s+(?:${NOT_FUTURE}${W}\\s+){0,3}(?:cancelad|anulad)[oa]s?${E}`,
      `${S}(?:le|lo|la|ya)\\s+(?:cancelé|anulé)${E}`,
    ],
  },
  {
    kind: 'any',
    patterns: [
      "\\b(?:you'?re|you are)\\s+all\\s+set\\b|\\bsee you (?:on|at|then|next)\\b|\\b(?:appointment|booking) is (?:all )?set\\b",
      '^(?:done|all done|all set)\\b',
      `${S}todo\\s+(?:est[aá]\\s+)?listo${E}|${S}nos\\s+vemos\\s+(?:el|la|a|en|entonces|pronto|ma[nñ]ana)${E}`,
      `^[¡]?\\s*(?:listo|hecho)${E}`,
    ],
  },
  {
    // No keyword, but the same false impression: "your appointment is on Tuesday at
    // 10:00" with a free slot and no booking. True only if that appointment exists.
    kind: 'appointment',
    patterns: [
      "\\byou(?:'ve got| have got| (?:already |still |now )?have)\\s+(?:an?\\s+|your\\s+)?(?:\\w+\\s+)?(?:appointment|booking|visit)\\b",
      '\\byour\\s+(?:appointment|booking|visit)\\b.{0,40}\\b(?:is|will be)\\s+(?:on|at|for|with)\\b',
      "\\b(?:we|i|they|dr\\s+\\w+)(?:'ll| will)\\s+see\\s+you\\b",
      'অ্যাপয়েন্টমেন্ট.{0,40}(?:আছে|রয়েছে|হবে)',
      `${S}(?:ya\\s+|todav[ií]a\\s+|a[uú]n\\s+)?tiene\\s+(?:una\\s+|su\\s+|la\\s+)?(?:${W}\\s+)?(?:${BOOKING_ES})${E}`,
      `${S}su\\s+(?:${BOOKING_ES})${E}.{0,40}${S}(?:es|ser[aá]|est[aá])\\s+(?:el|la|a\\s+las?|para|con)${E}`,
      `${S}(?:le|lo|la)\\s+(?:esperamos|esperaremos|veremos|atender[aá])${E}`,
    ],
  },
].map(({ kind, patterns }) => ({ kind, patterns: patterns.map(re) }));

// Anywhere in the phrase: the claim is being denied, or is about someone else.
const NEGATED = re(
  "\\b(?:not|never|no longer|cannot|unable|failed|someone else|another patient|booked by|already booked|already taken|fully booked)\\b|n't\\b|" +
    'হয়নি|হয় নি|হবে না|নয়|পারিনি|পারছি না|পারব না|অন্য কেউ|অন্য রোগী|ইতিমধ্যে|(?:^|\\s)না(?:\\s|[,.।?!]|$)',
);
// Before the claim: it is conditional, not a statement of fact.
const CONDITIONAL = re(
  '\\b(?:if|once|when|after|until|will be|would be|need to|needs to|have to|can be|could be|to be)\\b|যদি|' +
    `${S}(?:si|cuando|una\\s+vez\\s+que|en\\s+cuanto|hasta\\s+que|para\\s+que|antes\\s+de\\s+que|` +
    `despu[eé]s\\s+de\\s+que|necesit[oa]|hay\\s+que|tiene\\s+que|puede\\s+ser|podr[ií]a\\s+ser|para\\s+ser)${E}`,
);

// Spanish negates right before the verb ("no está confirmada", "aún no le he
// reservado"), so "no" only counts close to the claim: "No olvide que su cita está
// confirmada" still makes the claim. Being someone else's counts anywhere.
const ES_NEGATION_NEAR = re(`${S}(?:no|nunca|jam[aá]s|tampoco|ni)${E}`);
const ES_SOMEONE_ELSE = re(
  `${S}(?:otra\\s+persona|otr[oa]\\s+paciente|alguien(?:\\s+m[aá]s)?|ocupad[oa]s?)${E}`,
);

function negated(phrase, match) {
  if (NEGATED.test(phrase) || ES_SOMEONE_ELSE.test(phrase)) return true;
  const near = phrase.slice(Math.max(0, match.index - 12), match.index + match[0].length);
  return ES_NEGATION_NEAR.test(near);
}

const REQUIRED_ACTIONS = {
  booked: ['create', 'reschedule'],
  rescheduled: ['reschedule'],
  cancelled: ['cancel'],
  any: ['create', 'reschedule', 'cancel'],
};

function findClaim(phrase) {
  for (const { kind, patterns } of CLAIMS) {
    for (const pattern of patterns) {
      const match = pattern.exec(phrase);
      if (!match) continue;
      if (negated(phrase, match)) continue;
      if (CONDITIONAL.test(phrase.slice(0, match.index))) continue;
      return kind;
    }
  }
  return null;
}

function detailsMatch(clause, verified, now, tz) {
  const known = verified.flatMap((v) => [v.booking, v.previous].filter(Boolean));
  const times = extractTimes(clause);
  const dates = extractDates(clause, now, tz);
  const timesOk = times.every((time) =>
    known.some((booking) => time.minutes.includes(localParts(booking.start, tz).minutes)),
  );
  const datesOk = dates.every((date) => known.some((booking) => dateMatches(date, booking.start, tz)));
  return timesOk && datesOk;
}

/** Does one real, standing appointment match everything this clause says about it? */
function matchesActiveBooking(clause, activeBookings, providers, now, tz) {
  const named = mentionedProviders(clause, providers);
  const times = extractTimes(clause);
  const dates = extractDates(clause, now, tz);
  return activeBookings.some(
    (booking) =>
      (!named.length || named.some((p) => p.id === booking.providerId)) &&
      times.every((time) => time.minutes.includes(localParts(booking.start, tz).minutes)) &&
      dates.every((date) => dateMatches(date, booking.start, tz)),
  );
}

/**
 * "Confirmed" (and its equivalents, in English, Spanish and Bangla) may only be said in the turn
 * a matching write was verified, and only about that booking's own date and time.
 * Telling a patient they simply "have an appointment" needs that appointment to exist.
 *
 * @param {object} args
 * @param {Array<{ action: string, booking: { start: string }, previous?: { start: string } }>} args.verified
 *   writes that passed booking verify in this turn
 * @param {Array<{ providerId: string, start: string }>} [args.activeBookings]
 *   standing appointments the tools have returned in this conversation
 * @param {Array<{ id: string, name: string, nameBn?: string }>} [args.providers]
 */
export function checkConfirmation({ reply, verified = [], activeBookings = [], providers = [], now, tz }) {
  const violations = [];
  for (const { text, isQuestion } of splitClauses(reply)) {
    if (isQuestion) continue;
    // Commas separate a claim from its neighbours: "Don't worry, it is confirmed".
    for (const phrase of text.split(/[,،]/)) {
      const kind = findClaim(phrase.trim());
      if (!kind) continue;
      if (kind === 'appointment') {
        if (!matchesActiveBooking(text, activeBookings, providers, now, tz)) {
          violations.push({ kind, reason: 'no_such_appointment', clause: text });
        }
        continue;
      }
      const matching = verified.filter((v) => REQUIRED_ACTIONS[kind].includes(v.action));
      if (matching.length === 0) {
        violations.push({ kind, reason: 'no_verified_write', clause: text });
      } else if (!detailsMatch(text, matching, now, tz)) {
        violations.push({ kind, reason: 'details_differ_from_verified_booking', clause: text });
      }
    }
  }
  return {
    guard: 'confirmation_check',
    ok: violations.length === 0,
    violations,
    verified: verified.map((v) => v.action),
  };
}
