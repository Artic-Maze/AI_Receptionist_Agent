// Pulls times, dates and availability claims out of a reply, in English, Spanish
// and Bangla, so reply guards can compare what was said with what the tools returned.
// Bangla numerals are converted first, so every pattern only handles ASCII digits.
//
// Spanish words carry accents, and \b only knows ASCII letters, so Spanish patterns
// mark word edges with WORD_START and WORD_END instead.

import { localParts, toAsciiDigits } from '../time.js';

const nfc = (text) => text.normalize('NFC');
const re = (source, flags = 'gu') => new RegExp(nfc(source), flags);

/** Word edges that work for accented letters, unlike \b. */
export const WORD_START = '(?<![\\p{L}\\p{N}])';
export const WORD_END = '(?![\\p{L}\\p{N}])';
const S = WORD_START;
const E = WORD_END;

export function normalize(text) {
  return (
    toAsciiDigits(nfc(String(text)))
      // "a.m.", "A.M." and the Spanish "a. m." all become "am". A dot that also ends
      // the sentence stays, or "…confirmed for 10 a.m. Is there anything else?" would
      // read as one long question, and questions are not checked for claims.
      .replace(/(?<!\p{L})([aApP])\.\s?([mM])\.(?=\s+[\p{Lu}¿¡])/gu, '$1$2.')
      .replace(/(?<!\p{L})([aApP])\.\s?([mM])\.?/gu, '$1$2')
      .toLowerCase()
      // Models often write curly apostrophes; "you’re booked" must still count as a claim.
      .replace(/[’‘ʼ]/g, "'")
      // Titles, so their dots don't end a sentence: Dr., Dra., Sr., Sra.
      .replace(/\b(dra?|sra?|srta)\./g, '$1')
      .replace(re('ডা\\.', 'g'), 'ডা')
  );
}

const CLAUSE_BREAK = re(
  '\\s*(?:;|,?\\s+(?:but|however|although|though|instead|alternatively)\\b|' +
    `,?\\s+(?:pero|sin embargo|aunque|en cambio|en su lugar|como alternativa)${E}|` +
    '\\s+(?:তবে|কিন্তু|বরং)\\s+)\\s*',
);

/** Split a reply into clauses so a refusal can't shelter an offer in the same sentence. */
export function splitClauses(text) {
  const clauses = [];
  for (const line of normalize(text).split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?।])\s+/)) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      const isQuestion = trimmed.endsWith('?');
      for (const part of trimmed.split(CLAUSE_BREAK)) {
        if (part.trim()) clauses.push({ text: part.trim(), isQuestion });
      }
    }
  }
  return clauses;
}

// ---- Times -----------------------------------------------------------------

const BN_FORMAL_AM = nfc('পূর্বাহ্ণ');
const BN_FORMAL_PM = nfc('অপরাহ্ণ');
const BN_AM = ['সকাল', 'ভোর'].map(nfc);
const BN_PM = ['বিকাল', 'বিকেল', 'সন্ধ্যা'].map(nfc);
const BN_NOON = nfc('দুপুর');
const BN_NIGHT = nfc('রাত');

function bnMeridiem(context, hour) {
  // The nearest period word wins: "সকাল ১০টা থেকে বিকাল ৫টা" has one for each time.
  const words = [...BN_AM, ...BN_PM, BN_NOON, BN_NIGHT];
  let best = null;
  let bestAt = -1;
  for (const word of words) {
    const at = context.lastIndexOf(word);
    if (at > bestAt) {
      best = word;
      bestAt = at;
    }
  }
  if (!best) return null;
  if (BN_AM.includes(best)) return 'am';
  if (BN_PM.includes(best)) return 'pm';
  if (best === BN_NOON) return hour >= 11 && hour < 12 ? 'am' : 'pm';
  // Night: 9, 10, 11 are pm; 12 to 4 are after midnight.
  return hour >= 5 && hour < 12 ? 'pm' : 'am';
}

/** "de la tarde" and the like: am or pm for a Spanish period word. */
function esPeriod(word, hour) {
  // Night, as in Bangla: 9, 10, 11 are pm; 12 to 4 are after midnight.
  if (word === 'noche') return hour >= 5 && hour < 12 ? 'pm' : 'am';
  if (word === 'tarde' || word.startsWith('mediod')) return 'pm';
  return 'am'; // mañana, madrugada
}

// Spanish usually puts the period after the time ("a las 10 de la mañana"), and
// sometimes before it ("por la tarde, a las 4").
const ES_PERIOD_AFTER = re(`^\\s*(?:(?:de|en|por)\\s+la\\s+(ma[nñ]ana|tarde|noche|madrugada)|del\\s+(mediod[ií]a))${E}`, 'u');
const ES_PERIOD_BEFORE = re(`${S}(?:(?:por|en|de)\\s+la|esta|esa)\\s+(ma[nñ]ana|tarde|noche|madrugada)${E}`, 'gu');

function esMeridiem(before, after, hour) {
  const following = ES_PERIOD_AFTER.exec(after);
  if (following) return esPeriod(following[1] ?? following[2], hour);
  const preceding = [...before.matchAll(ES_PERIOD_BEFORE)].at(-1);
  return preceding ? esPeriod(preceding[1], hour) : null;
}

/** Every minute-of-day this mention could mean. "10:00" alone could be am or pm. */
function candidateMinutes(hour, minute, meridiem) {
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'am') return [(hour % 12) * 60 + minute];
  if (meridiem === 'pm') return [((hour % 12) + 12) * 60 + minute];
  if (hour === 0 || hour > 12) return [hour * 60 + minute];
  return [(hour % 12) * 60 + minute, ((hour % 12) + 12) * 60 + minute];
}

const MONTH_WORD =
  'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|' +
  'september|sept|sep|october|oct|november|nov|december|dec';
const MONTH_ES =
  'enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|' +
  'septiembre|setiembre|sept|sep|set|octubre|oct|noviembre|nov|diciembre|dic';

// Nouns a Spanish number is counting, so "las 2 opciones" is not two o'clock.
const ES_COUNTED =
  'personas?|citas?|opciones|horas|minutos|d[ií]as|semanas|meses|a[nñ]os|veces|pacientes|' +
  'm[eé]dic[oa]s|doctor[\\p{L}]*|huecos?|plazas?|turnos?';

const ES_MINUTE_WORDS = { media: 30, cuarto: 15 };

const TIME_PATTERNS = [
  // 10:30, 10:30 am, 15:00, ১০:৩০ (digits already converted)
  { source: '(?<![\\d:+])(\\d{1,2}):(\\d{2})(?!\\d)(?:\\s*(am|pm)\\b)?', hour: 1, minute: 2, mer: 3 },
  // 10.30 am: the dot form only counts with am/pm, or it would match prices.
  { source: '(?<![\\d:.+])(\\d{1,2})\\.(\\d{2})\\s*(am|pm)\\b', hour: 1, minute: 2, mer: 3 },
  // 10 am, 3pm
  { source: '(?<![\\d:.+])(\\d{1,2})\\s*(am|pm)\\b', hour: 1, mer: 2 },
  // 10 o'clock
  { source: "(?<![\\d:.+])(\\d{1,2})\\s*o['’]?clock\\b", hour: 1 },
  // at 10 (but not "at 10:30", "at 10 am" or "at 10 november")
  {
    source: `\\bat\\s+(\\d{1,2})(?![\\d:.])(?!\\s*(?:am|pm|st|nd|rd|th|o['’]?clock)\\b)(?!\\s*(?:${MONTH_WORD})\\b)`,
    hour: 1,
  },
  // ১০টা, ১০টায়, but not "২টা স্লট" (two slots) or "১০ টাকা" (ten taka)
  {
    source: '(?<![\\d:.+])(\\d{1,2})\\s*(?:টায়|টার|টা|টে)(?!কা)(?!\\s*(?:স্লট|অপশন|সিরিয়াল|ডাক্তার))',
    hour: 1,
  },
  // a las 10, desde las 9, la 1 (but not "las 10:30", "las 10 y media", "las 2 opciones")
  {
    source:
      `${S}las?\\s+(\\d{1,2})(?![\\p{L}\\d:.])(?!\\s*(?:am|pm)\\b)(?!\\s+(?:y\\s+(?:media|cuarto)|menos\\s+cuarto)${E})` +
      `(?!\\s+(?:de\\s+)?(?:${MONTH_ES})${E})(?!\\s+(?:de\\s+)?(?:${ES_COUNTED})${E})`,
    hour: 1,
  },
  // 10 y media, 10 y cuarto
  { source: `(?<![\\d:.+])(\\d{1,2})\\s+y\\s+(media|cuarto)${E}`, hour: 1, minuteWord: 2 },
  // 11 menos cuarto, which is 10:45
  { source: `(?<![\\d:.+])(\\d{1,2})\\s+menos\\s+cuarto${E}`, hour: 1, quarterTo: true },
  // 10 de la mañana, 4 de la tarde, when "la"/"las" hasn't already introduced the number
  {
    source:
      `(?<![\\d:.+])(?<!${S}las?\\s+)(\\d{1,2})(?![\\d:.])` +
      `(?=\\s+(?:(?:de|en|por)\\s+la\\s+(?:ma[nñ]ana|tarde|noche|madrugada)|del\\s+mediod[ií]a)${E})`,
    hour: 1,
  },
];

const TIME_REGEXES = TIME_PATTERNS.map((p) => ({ ...p, regex: re(p.source) }));

// "al mediodía" is a time; "las 12:30 del mediodía" only says which half of the day.
const ES_NOON = re(`(?<!${S}del\\s)${S}(mediod[ií]a|medianoche)${E}`);

export function extractTimes(rawText) {
  const text = normalize(rawText);
  const found = [];
  for (const { regex, hour: h, minute: m, mer, minuteWord, quarterTo } of TIME_REGEXES) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      let hour = Number(match[h]);
      let minute = m ? Number(match[m]) : 0;
      if (minuteWord) minute = ES_MINUTE_WORDS[match[minuteWord]];
      if (quarterTo) {
        hour = hour <= 1 ? 12 : hour - 1;
        minute = 45;
      }
      let meridiem = mer ? match[mer] : null;
      if (!meridiem) {
        const end = match.index + match[0].length;
        const before = text.slice(Math.max(0, match.index - 24), match.index);
        const after = text.slice(end, end + 24);
        if (after.slice(0, 12).includes(BN_FORMAL_AM)) meridiem = 'am';
        else if (after.slice(0, 12).includes(BN_FORMAL_PM)) meridiem = 'pm';
        else meridiem = bnMeridiem(before.slice(-14), hour) ?? esMeridiem(before, after, hour);
      }
      const minutes = candidateMinutes(hour, minute, meridiem);
      if (minutes) found.push({ raw: match[0].trim(), minutes, index: match.index });
    }
  }
  for (const match of text.matchAll(/\b(noon|midday|midnight)\b/g)) {
    found.push({
      raw: match[0],
      minutes: [match[0] === 'midnight' ? 0 : 720],
      index: match.index,
    });
  }
  ES_NOON.lastIndex = 0;
  for (const match of text.matchAll(ES_NOON)) {
    found.push({ raw: match[0], minutes: [match[1] === 'medianoche' ? 0 : 720], index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---- Dates -----------------------------------------------------------------

const EN_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const BN_MONTHS = new Map(
  [
    'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
    'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
  ].map((name, i) => [nfc(name), i + 1]),
);
BN_MONTHS.set(nfc('জানুয়ারী'), 1);
BN_MONTHS.set(nfc('ফেব্রুয়ারী'), 2);
BN_MONTHS.set(nfc('আগষ্ট'), 8);

/** Spanish month names and abbreviations, by their first three letters. */
const ES_MONTHS = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

const EN_WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const EN_WEEKDAY_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const BN_WEEKDAYS = new Map(
  [
    ['রবিবার', 0], ['রোববার', 0], ['সোমবার', 1], ['মঙ্গলবার', 2], ['বুধবার', 3],
    ['বৃহস্পতিবার', 4], ['শুক্রবার', 5], ['শনিবার', 6],
  ].map(([name, day]) => [nfc(name), day]),
);
const ES_WEEKDAYS = {
  domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6,
};

const BN_MONTH_ALT = [...BN_MONTHS.keys()].join('|');
const BN_WEEKDAY_ALT = [...BN_WEEKDAYS.keys()].join('|');

const DAY_FIRST = re(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_WORD})\\b`);
// The lookaheads stop "5 Nov 10 am" reading as November 10 as well as November 5.
const MONTH_FIRST = re(
  `\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![:\\d])(?!\\s*(?:am|pm|o['’]?clock)\\b)`,
);
const BN_DAY_FIRST = re(`(?<!\\d)(\\d{1,2})(?:ই|শে|লা|রা|ঠা)?\\s*(${BN_MONTH_ALT})`);
const BN_MONTH_FIRST = re(`(${BN_MONTH_ALT})\\s*(\\d{1,2})(?![:\\d])(?!\\s*(?:টায়|টার|টা|টে))`);
// 17 de noviembre, 3 de nov.
const ES_DAY_FIRST = re(`(?<![\\d\\p{L}])(\\d{1,2})\\s+de\\s+(${MONTH_ES})${E}`);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WEEKDAY_FULL = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g;
const WEEKDAY_ABBR = /\b(sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)[,.]/g;
const BN_WEEKDAY = re(`(${BN_WEEKDAY_ALT})`);
const ES_WEEKDAY = re(`${S}(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)s?${E}`);

// "mañana" is tomorrow, unless it is the morning: "por la mañana", "esta mañana".
const ES_TOMORROW = re(`(?<!${S}(?:la|esta|esa|cada|una|toda)\\s)${S}ma[nñ]ana${E}`, 'u');
const ES_DAY_AFTER_TOMORROW = re(`${S}pasado\\s+ma[nñ]ana${E}`, 'u');
const ES_TODAY = re(`${S}(?:hoy|esta\\s+(?:ma[nñ]ana|tarde|noche))${E}`, 'u');

function addDays(now, days, tz) {
  const p = localParts(now, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return date.toISOString().slice(0, 10);
}

/** Dates as predicates: "Tuesday" can match any Tuesday, "Nov 10" only that day. */
export function extractDates(rawText, now, tz) {
  const text = normalize(rawText);
  const found = [];
  for (const m of text.matchAll(ISO_DATE)) found.push({ raw: m[0], key: m[0] });
  for (const m of text.matchAll(DAY_FIRST)) {
    found.push({ raw: m[0], day: Number(m[1]), month: EN_MONTHS[m[2].slice(0, 3)] });
  }
  for (const m of text.matchAll(MONTH_FIRST)) {
    found.push({ raw: m[0], month: EN_MONTHS[m[1].slice(0, 3)], day: Number(m[2]) });
  }
  for (const m of text.matchAll(BN_DAY_FIRST)) {
    found.push({ raw: m[0], day: Number(m[1]), month: BN_MONTHS.get(m[2]) });
  }
  for (const m of text.matchAll(BN_MONTH_FIRST)) {
    found.push({ raw: m[0], month: BN_MONTHS.get(m[1]), day: Number(m[2]) });
  }
  for (const m of text.matchAll(ES_DAY_FIRST)) {
    found.push({ raw: m[0], day: Number(m[1]), month: ES_MONTHS[m[2].slice(0, 3)] });
  }
  for (const m of text.matchAll(WEEKDAY_FULL)) found.push({ raw: m[0], weekday: EN_WEEKDAYS[m[1]] });
  for (const m of text.matchAll(WEEKDAY_ABBR)) {
    found.push({ raw: m[0], weekday: EN_WEEKDAY_ABBR[m[1]] });
  }
  for (const m of text.matchAll(BN_WEEKDAY)) found.push({ raw: m[0], weekday: BN_WEEKDAYS.get(m[1]) });
  for (const m of text.matchAll(ES_WEEKDAY)) found.push({ raw: m[0], weekday: ES_WEEKDAYS[m[1]] });

  if (now) {
    if (/\bday after tomorrow\b/.test(text) || text.includes(nfc('পরশু')) || ES_DAY_AFTER_TOMORROW.test(text)) {
      found.push({ raw: 'day after tomorrow', key: addDays(now, 2, tz) });
    } else if (/\btomorrow\b/.test(text) || text.includes(nfc('আগামীকাল')) || ES_TOMORROW.test(text)) {
      found.push({ raw: 'tomorrow', key: addDays(now, 1, tz) });
    }
    if (/\btoday\b/.test(text) || re('(?:^|\\s)আজ(?:কে)?(?:\\s|$)', 'u').test(text) || ES_TODAY.test(text)) {
      found.push({ raw: 'today', key: addDays(now, 0, tz) });
    }
  }
  return found;
}

export function dateMatches(mention, instant, tz) {
  const p = localParts(instant, tz);
  if (mention.key) return mention.key === p.dateKey;
  if (mention.weekday !== undefined) return mention.weekday === p.weekday;
  return mention.month === p.month && mention.day === p.day;
}

// ---- Claims ----------------------------------------------------------------

export const UNAVAILABLE = re(
  "\\b(?:not available|isn't available|aren't available|unavailable|no longer|not free|isn't free|" +
    "is taken|was taken|been taken|already booked|already taken|fully booked|booked by|someone else|" +
    "no slots?|no availability|no appointments?|no openings?|not open|can't offer|cannot offer|" +
    "couldn't find|could not find|on leave|don't have|do not have|doesn't have|does not have|" +
    "not have|not offering)\\b|" +
    // Spanish. "No hay problema" is not a refusal, so it must not excuse what follows.
    `${S}(?:no\\s+(?:est[aá]n?|hay(?!\\s+(?:problema|inconveniente|de\\s+qu[eé])${E})|tiene|tienen|tenemos|tengo|queda|quedan|` +
    `puedo|podemos|encontr[eé]|encuentro|he\\s+encontrado|pude|atiende|trabaja|pasa\\s+consulta|ofrece)|ya\\s+no|` +
    'ocupad[oa]s?|complet[oa]s?|sin\\s+(?:disponibilidad|huecos?|citas?)|de\\s+vacaciones|de\\s+baja|de\\s+permiso|' +
    // Taken by someone else; "para otra persona" is only who a booking is for.
    `por\\s+(?:otra\\s+persona|otr[oa]\\s+paciente|alguien)|(?:otra\\s+persona|otr[oa]\\s+paciente|alguien(?:\\s+m[aá]s)?)` +
    `\\s+(?:(?:ya|se)\\s+)?(?:(?:lo|la|le)\\s+)?(?:acaba\\s+de\\s+reservar|ha\\s+reservado|reserv[oó])|` +
    `(?:acaba\\s+de\\s+reservar|ha\\s+reservado|reserv[oó])\\s+(?:otra\\s+persona|otr[oa]\\s+paciente|alguien))${E}|` +
    'নেই|পাওয়া যাচ্ছে না|পাওয়া যায়নি|পাওয়া যাবে না|বুক হয়ে গেছে|বুক হয়ে গিয়েছে|অন্য কেউ|ছুটিতে|দিতে পারছি না|সম্ভব নয়|সম্ভব না',
  'u',
);

const AVAILABILITY_CLAIM = re(
  '\\b(?:available|availability|free|open|openings?|slots?)\\b|\\bi (?:can|could) (?:offer|book|fit)\\b|' +
    '\\b(?:we|i) have\\b|\\bhas (?:time|room)\\b|' +
    `${S}(?:disponibles?|disponibilidad|libres?|huecos?|horarios?|(?:le\\s+)?(?:puedo|podemos)\\s+(?:ofrecer|reservar)|` +
    `tenemos|tengo|hay|quedan?)${E}|` +
    'খালি|ফাঁকা|স্লট|সময় আছে|পাওয়া যাবে|পাবেন|আছে',
  'u',
);

export const claimsAvailability = (text) => AVAILABILITY_CLAIM.test(text);

/**
 * Split a clause around a statement of unavailability. "10:00 is taken, 11:00 is
 * open" must not let the first half excuse the second, while "not available at
 * 10:00" names the unavailable time after the marker and is excused whole.
 */
export function decompose(text) {
  const match = UNAVAILABLE.exec(text);
  if (!match) return [{ text, exempt: false }];
  const end = match.index + match[0].length;
  const rest = text.slice(end);
  if (/^\s*(?:,|&|and\b|y(?!\p{L})|،)/u.test(rest) && extractTimes(rest).length > 0) {
    return [{ text: text.slice(0, end), exempt: true }, ...decompose(rest)];
  }
  // "Not available on Tuesday, I can offer Wednesday at 10:00": an offer after a comma
  // is a statement of its own, so the refusal before it doesn't excuse it.
  const comma = rest.search(/[,،]/);
  if (comma >= 0) {
    const after = rest.slice(comma + 1);
    if (claimsAvailability(after) && extractTimes(after).length > 0) {
      return [{ text: text.slice(0, end + comma), exempt: true }, ...decompose(after)];
    }
  }
  return [{ text, exempt: true }];
}
