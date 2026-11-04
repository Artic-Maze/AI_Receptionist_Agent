// Pulls times, dates and availability claims out of a reply, in English and
// Bangla, so reply guards can compare what was said with what the tools returned.
// Bangla numerals are converted first, so every pattern only handles ASCII digits.

import { localParts, toAsciiDigits } from '../time.js';

const nfc = (text) => text.normalize('NFC');
const re = (source, flags = 'gu') => new RegExp(nfc(source), flags);

export function normalize(text) {
  return toAsciiDigits(nfc(String(text)))
    .toLowerCase()
    // Models often write curly apostrophes; "you’re booked" must still count as a claim.
    .replace(/[’‘ʼ]/g, "'")
    .replace(/\bdr\./g, 'dr')
    .replace(re('ডা\\.', 'g'), 'ডা')
    .replace(/\ba\.m\.?/g, 'am')
    .replace(/\bp\.m\.?/g, 'pm');
}

const CLAUSE_BREAK = re(
  '\\s*(?:;|,?\\s+(?:but|however|although|though|instead|alternatively)\\b|\\s+(?:তবে|কিন্তু|বরং)\\s+)\\s*',
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
];

const TIME_REGEXES = TIME_PATTERNS.map((p) => ({ ...p, regex: re(p.source) }));

export function extractTimes(rawText) {
  const text = normalize(rawText);
  const found = [];
  for (const { regex, hour: h, minute: m, mer } of TIME_REGEXES) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const hour = Number(match[h]);
      const minute = m ? Number(match[m]) : 0;
      let meridiem = mer ? match[mer] : null;
      if (!meridiem) {
        const before = text.slice(Math.max(0, match.index - 14), match.index);
        const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
        if (after.includes(BN_FORMAL_AM)) meridiem = 'am';
        else if (after.includes(BN_FORMAL_PM)) meridiem = 'pm';
        else meridiem = bnMeridiem(before, hour);
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

const BN_MONTH_ALT = [...BN_MONTHS.keys()].join('|');
const BN_WEEKDAY_ALT = [...BN_WEEKDAYS.keys()].join('|');

const DAY_FIRST = re(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_WORD})\\b`);
// The lookaheads stop "5 Nov 10 am" reading as November 10 as well as November 5.
const MONTH_FIRST = re(
  `\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![:\\d])(?!\\s*(?:am|pm|o['’]?clock)\\b)`,
);
const BN_DAY_FIRST = re(`(?<!\\d)(\\d{1,2})(?:ই|শে|লা|রা|ঠা)?\\s*(${BN_MONTH_ALT})`);
const BN_MONTH_FIRST = re(`(${BN_MONTH_ALT})\\s*(\\d{1,2})(?![:\\d])(?!\\s*(?:টায়|টার|টা|টে))`);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WEEKDAY_FULL = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g;
const WEEKDAY_ABBR = /\b(sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)[,.]/g;
const BN_WEEKDAY = re(`(${BN_WEEKDAY_ALT})`);

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
  for (const m of text.matchAll(WEEKDAY_FULL)) found.push({ raw: m[0], weekday: EN_WEEKDAYS[m[1]] });
  for (const m of text.matchAll(WEEKDAY_ABBR)) {
    found.push({ raw: m[0], weekday: EN_WEEKDAY_ABBR[m[1]] });
  }
  for (const m of text.matchAll(BN_WEEKDAY)) found.push({ raw: m[0], weekday: BN_WEEKDAYS.get(m[1]) });

  if (now) {
    if (/\bday after tomorrow\b/.test(text) || text.includes(nfc('পরশু'))) {
      found.push({ raw: 'day after tomorrow', key: addDays(now, 2, tz) });
    } else if (/\btomorrow\b/.test(text) || text.includes(nfc('আগামীকাল'))) {
      found.push({ raw: 'tomorrow', key: addDays(now, 1, tz) });
    }
    if (/\btoday\b/.test(text) || re('(?:^|\\s)আজ(?:কে)?(?:\\s|$)', 'u').test(text)) {
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
    'নেই|পাওয়া যাচ্ছে না|পাওয়া যায়নি|পাওয়া যাবে না|বুক হয়ে গেছে|বুক হয়ে গিয়েছে|অন্য কেউ|ছুটিতে|দিতে পারছি না|সম্ভব নয়|সম্ভব না',
  'u',
);

const AVAILABILITY_CLAIM = re(
  '\\b(?:available|availability|free|open|openings?|slots?)\\b|\\bi (?:can|could) (?:offer|book|fit)\\b|' +
    '\\b(?:we|i) have\\b|\\bhas (?:time|room)\\b|খালি|ফাঁকা|স্লট|সময় আছে|পাওয়া যাবে|পাবেন|আছে',
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
  if (/^\s*(?:,|&|and\b|،)/.test(rest) && (extractTimes(rest).length > 0)) {
    return [{ text: text.slice(0, end), exempt: true }, ...decompose(rest)];
  }
  return [{ text, exempt: true }];
}
