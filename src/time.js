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
// Lower case, as Spanish writes them.
const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
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

/** The calendar date `days` after a YYYY-MM-DD date. */
export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 for Sunday. A calendar date has a weekday whatever the time zone. */
export function weekdayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayBounds(dateKey, tz) {
  return { start: parseLocal(`${dateKey}T00:00`, tz), end: parseLocal(`${addDays(dateKey, 1)}T00:00`, tz) };
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

/** A wall-clock time, given as minutes after midnight: "9:00 AM", "9:00 a. m.", "সকাল ৯:০০". */
export function clockLabels(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = String(minutes % 60).padStart(2, '0');
  return {
    en: `${hour12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`,
    es: `${hour12}:${mm} ${hour < 12 ? 'a. m.' : 'p. m.'}`,
    bn: `${bnPeriod(hour)} ${toBnDigits(hour12)}:${toBnDigits(mm)}`,
  };
}

/** The date and the time of an instant, labelled separately. */
export function labelParts(instant, tz) {
  const p = localParts(instant, tz);
  const time = clockLabels(p.minutes);
  return {
    date_en: `${WEEKDAYS_EN[p.weekday]}, ${MONTHS_EN[p.month - 1]} ${p.day}`,
    date_es: `${WEEKDAYS_ES[p.weekday]}, ${p.day} de ${MONTHS_ES[p.month - 1]}`,
    date_bn: `${WEEKDAYS_BN[p.weekday]}, ${toBnDigits(p.day)} ${MONTHS_BN[p.month - 1]}`,
    time_en: time.en,
    time_es: time.es,
    time_bn: time.bn,
  };
}

/** Ready-to-say labels, so the model never has to do date arithmetic in a reply. */
export function displayLabels(instant, tz) {
  const label = labelParts(instant, tz);
  return {
    display_en: `${label.date_en}, ${label.time_en}`,
    display_es: `${label.date_es}, ${label.time_es}`,
    display_bn: `${label.date_bn}, ${label.time_bn}`,
  };
}
