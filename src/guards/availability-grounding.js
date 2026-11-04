import { localParts } from '../time.js';
import {
  claimsAvailability,
  dateMatches,
  decompose,
  extractDates,
  extractTimes,
  normalize,
  splitClauses,
} from './text-extract.js';

/**
 * What the reply is allowed to treat as real, rebuilt from the ToolCall log: the
 * latest availability per provider, minus slots a write has since found taken,
 * plus every booking a tool has actually returned in this conversation.
 *
 * `bookings` may be mentioned at all ("it was at 10:00"). `activeBookings` are the
 * ones that still stand, which are the only ones the patient can be told they have.
 */
export async function loadGrounding(prisma, conversationId) {
  const rows = await prisma.toolCall.findMany({
    where: { conversationId },
    orderBy: { id: 'asc' },
  });
  const latest = new Map();
  const bookings = [];
  const active = new Map();
  const addBooking = (b) => {
    if (!b?.start) return;
    const entry = { providerId: b.provider_id, start: b.start, end: b.end };
    bookings.push(entry);
    if (b.id) {
      if (b.status === 'active') active.set(b.id, entry);
      else active.delete(b.id);
    }
  };
  for (const { tool, input, output } of rows) {
    if (!output) continue;
    if (tool === 'check_availability' && Array.isArray(output.slots)) {
      latest.set(
        output.provider_id,
        output.slots.map((s) => ({ providerId: output.provider_id, start: s.start, end: s.end })),
      );
    } else if (tool === 'find_patient') {
      for (const booking of output.upcoming_bookings ?? []) addBooking(booking);
    } else if (['create_booking', 'reschedule_booking'].includes(tool) && output.error === 'slot_unavailable') {
      const taken = new Date(input.start ?? input.new_start).getTime();
      for (const [provider, slots] of latest) {
        latest.set(provider, slots.filter((s) => new Date(s.start).getTime() !== taken));
      }
    } else if (!output.error) {
      addBooking(output.previous_booking);
      // A reschedule retires the old booking, even though it was active when returned.
      if (output.previous_booking?.id) active.delete(output.previous_booking.id);
      addBooking(output.booking);
    }
  }
  return { slots: [...latest.values()].flat(), bookings, activeBookings: [...active.values()] };
}

export function mentionedProviders(clause, providers) {
  return providers.filter((provider) => {
    const names = [provider.name, provider.nameBn].filter(Boolean);
    return names.some((name) => {
      const surname = normalize(name).replace(/^(?:dr\s*|ডা\s*)/u, '').trim();
      return surname && clause.includes(surname);
    });
  });
}

/**
 * Every time or date offered in the reply must exist in the data above, matched
 * as a pair: Tuesday and 10:00 each being real does not make "Tuesday at 10:00" real.
 *
 * Excused: clauses saying something is NOT available, and clarifying questions
 * that only repeat what the patient said ("which doctor would you like at 10?").
 * Repeating the patient's time in a statement is not excused, or a patient could
 * talk the agent into confirming a slot just by insisting on it.
 */
export function checkAvailabilityGrounding({ reply, grounding, patientTexts = [], providers = [], now, tz }) {
  const pool = [...grounding.slots, ...grounding.bookings];
  const patientTimes = patientTexts.flatMap((text) => extractTimes(text));
  const patientDates = patientTexts.flatMap((text) => extractDates(text, now, tz));
  const echoesTime = (time) => patientTimes.some((p) => p.minutes.some((m) => time.minutes.includes(m)));
  const dateId = (d) => d.key ?? (d.weekday !== undefined ? `weekday-${d.weekday}` : `${d.month}-${d.day}`);
  const echoesDate = (date) => patientDates.some((p) => dateId(p) === dateId(date));

  const violations = [];
  let checked = 0;
  let carriedDates = [];

  for (const { text: clauseText, isQuestion } of splitClauses(reply)) {
    for (const { text, exempt } of decompose(clauseText)) {
      const times = extractTimes(text);
      const dates = extractDates(text, now, tz);
      if (dates.length) carriedDates = dates;
      if (exempt || (!times.length && !dates.length)) continue;
      checked += times.length + dates.length;

      const named = mentionedProviders(text, providers);
      const byProvider = named.length
        ? pool.filter((slot) => named.some((p) => p.id === slot.providerId))
        : pool;
      // Times with no date of their own belong to the last date mentioned ("Tuesday: 10:00, 10:30").
      const dateFilter = dates.length ? dates : carriedDates;
      const candidates = dateFilter.length
        ? byProvider.filter((slot) => dateFilter.some((d) => dateMatches(d, slot.start, tz)))
        : byProvider;

      for (const time of times) {
        const grounded = candidates.some((slot) => {
          const start = localParts(slot.start, tz).minutes;
          const end = slot.end ? localParts(slot.end, tz).minutes : start;
          return time.minutes.includes(start) || time.minutes.includes(end);
        });
        if (!grounded && !(isQuestion && echoesTime(time))) {
          violations.push({ kind: 'time', mention: time.raw, clause: text });
        }
      }

      if (!times.length && claimsAvailability(text) && candidates.length === 0) {
        if (!(isQuestion && dates.every(echoesDate))) {
          violations.push({ kind: 'date', mention: dates.map((d) => d.raw).join(', '), clause: text });
        }
      }
    }
  }

  return { guard: 'availability_grounding', ok: violations.length === 0, checked, violations };
}
