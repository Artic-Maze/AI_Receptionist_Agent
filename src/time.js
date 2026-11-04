// Clinic-time helpers. Everything is stored and compared as an instant; wall-clock
// values only exist at the edges (what the patient sees, what a scenario seeds).

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export const toAsciiDigits = (text) =>
  String(text).replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

export const toBnDigits = (text) =>
  String(text).replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_BN = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_BN = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return formatters.get(tz);
}

/** The wall-clock fields of an instant in the given zone. */
export function localParts(instant, tz) {
  const fields = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(instant))) {
    fields[type] = value;
  }
  const year = Number(fields.year);
  const month = Number(fields.month);
  const day = Number(fields.day);
  const hour = Number(fields.hour);
  const minute = Number(fields.minute);
  const second = Number(fields.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAY_INDEX[fields.weekday],
    minutes: hour * 60 + minute,
    dateKey: `${fields.year}-${fields.month}-${fields.day}`,
  };
}

function offsetMinutes(instant, tz) {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000) / 60000);
}

/**
 * Parse a datetime. With an offset or Z it is taken as written; without one it
 * is wall-clock time in `tz` (how scenarios and seeds write their slots).
 */
export function parseLocal(value, tz) {
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(value)) return new Date(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!match) throw new Error(`Unparseable datetime: ${value}`);
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Two passes so a guess on the wrong side of a DST change still converges.
  const first = guess - offsetMinutes(guess, tz) * 60000;
  return new Date(guess - offsetMinutes(first, tz) * 60000);
}

/** e.g. 2026-11-10T10:00:00+06:00 */
export function toLocalIso(instant, tz) {
  const p = localParts(instant, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = offsetMinutes(instant, tz);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${p.dateKey}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function dayBounds(dateKey, tz) {
  const start = parseLocal(`${dateKey}T00:00`, tz);
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start, end: parseLocal(`${next}T00:00`, tz) };
}

function bnPeriod(hour) {
  if (hour < 4) return 'রাত';
  if (hour < 6) return 'ভোর';
  if (hour < 12) return 'সকাল';
  if (hour < 15) return 'দুপুর';
  if (hour < 18) return 'বিকাল';
  if (hour < 20) return 'সন্ধ্যা';
  return 'রাত';
}

/** Ready-to-say labels, so the model never has to do date arithmetic in a reply. */
export function displayLabels(instant, tz) {
  const p = localParts(instant, tz);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const mm = String(p.minute).padStart(2, '0');
  return {
    display_en:
      `${WEEKDAYS_EN[p.weekday]}, ${MONTHS_EN[p.month - 1]} ${p.day}, ` +
      `${hour12}:${mm} ${p.hour < 12 ? 'AM' : 'PM'}`,
    display_bn:
      `${WEEKDAYS_BN[p.weekday]}, ${toBnDigits(p.day)} ${MONTHS_BN[p.month - 1]}, ` +
      `${bnPeriod(p.hour)} ${toBnDigits(hour12)}:${toBnDigits(mm)}`,
  };
}
