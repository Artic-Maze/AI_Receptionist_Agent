import { z } from 'zod';

import { BookingNotActiveError, BookingNotFoundError } from '../calendar/adapter.js';
import { noteIdentityFailure } from '../agent/state.js';
import { dayBounds, displayLabels, toLocalIso } from '../time.js';
import { normalizePhone, searchPatients } from './identity.js';

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

const SlotView = z.object({
  start: isoDateTime,
  end: isoDateTime,
  display_en: z.string(),
  display_bn: z.string(),
});

const BookingView = z.object({
  id: z.string(),
  patient_id: z.string(),
  provider_id: z.string(),
  provider_name: z.string(),
  start: isoDateTime,
  end: isoDateTime,
  status: z.enum(['active', 'cancelled']),
  display_en: z.string(),
  display_bn: z.string(),
});

const ToolError = z.looseObject({ error: z.string(), message: z.string() });
const WriteOutput = z.union([
  z.looseObject({ booking: BookingView, previous_booking: BookingView.optional() }),
  ToolError,
]);

export const toolError = (error, message, extra = {}) => ({ error, message, ...extra });

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

function bookingView(booking, providers, tz) {
  const provider = providers.find((p) => p.id === booking.providerId);
  return {
    id: booking.id,
    patient_id: booking.patientId,
    provider_id: booking.providerId,
    provider_name: provider?.name ?? booking.providerId,
    start: toLocalIso(booking.start, tz),
    end: toLocalIso(booking.end, tz),
    status: booking.status,
    ...displayLabels(booking.start, tz),
  };
}

/** Would this new time collide with another of the patient's own appointments? */
function findOverlap(existing, start, slotMinutes, ignoreId) {
  const from = new Date(start).getTime();
  const to = from + slotMinutes * 60000;
  return existing.find(
    (b) =>
      b.id !== ignoreId &&
      from < new Date(b.end).getTime() &&
      new Date(b.start).getTime() < to,
  );
}

/**
 * Tools run through executeTool (./execute.js), which applies validation, guards,
 * retries, read-back verification and logging. Read tools return their output;
 * write tools return { output, verify } so the executor can check the write.
 */
export const TOOLS = {
  find_patient: {
    description:
      'Look up the patient you are talking to, or the family member they are booking for. Pass every ' +
      'identifier you have. Identity needs two identifiers matching exactly one patient; any phone number ' +
      'the channel provides is included automatically. On status "resolved" you also get their upcoming ' +
      'bookings. Each call replaces the current patient, so call it again when the patient changes.',
    input: z.object({
      name: z.string().min(1).max(120).optional().describe('Full name, in English or Bangla script.'),
      dob: isoDate.optional().describe('Date of birth as YYYY-MM-DD, whatever format the patient used.'),
      phone: z.string().min(5).max(30).optional().describe('Phone number the patient stated.'),
    }),
    output: z.union([
      z.object({
        status: z.literal('resolved'),
        patient: z.object({ id: z.string(), name: z.string(), name_bn: z.string().nullable() }),
        upcoming_bookings: z.array(BookingView),
      }),
      z.object({
        status: z.enum(['ambiguous', 'not_found', 'needs_more_info']),
        need: z.array(z.string()),
        message: z.string(),
      }),
    ]),
    async run(input, ctx) {
      const { deps, conversation, turn, tz } = ctx;
      const hint = conversation.state.callerPhone;
      const stated = input.phone ? normalizePhone(input.phone) : undefined;
      const phone = stated ?? hint;
      const { name, dob } = input;

      if (!phone && !name && !dob) {
        conversation.patientId = null;
        return {
          status: 'needs_more_info',
          need: ['full name', 'date of birth'],
          message: 'Ask the patient for these first.',
        };
      }

      let matches = await searchPatients(deps.prisma, { phone, name, dob });
      let identifiers = [phone, name, dob].filter(Boolean).length;
      // The phone on the channel may be a relative's. Two other identifiers still decide it.
      if (!matches.length && !stated && hint && name && dob) {
        matches = await searchPatients(deps.prisma, { name, dob });
        identifiers = 2;
      }

      // Every lookup replaces the current patient, so a failed lookup for a relative
      // can never leave the previous patient quietly in place for the next write.
      conversation.patientId = null;

      const missing = [!name && 'full name', !dob && 'date of birth'].filter(Boolean);

      if (matches.length === 1 && identifiers >= 2) {
        const [patient] = matches;
        conversation.patientId = patient.id;
        conversation.state.identityFailures = 0;
        turn.guardResults.push({ guard: 'identity_gate', ok: true, tool: 'find_patient', patientId: patient.id });
        const providers = await deps.calendar.listProviders();
        const upcoming = await deps.calendar.listBookingsForPatient(patient.id);
        return {
          status: 'resolved',
          patient: { id: patient.id, name: patient.name, name_bn: patient.nameBn },
          upcoming_bookings: upcoming.map((b) => bookingView(b, providers, tz)),
        };
      }

      if (matches.length === 1) {
        return {
          status: 'needs_more_info',
          need: missing,
          message: 'One more identifier is needed before this patient can be verified.',
        };
      }

      // No candidate details are returned: a caller must not learn who else is on this number.
      const status = matches.length > 1 ? 'ambiguous' : 'not_found';
      turn.guardResults.push({
        guard: 'identity_gate',
        ok: false,
        tool: 'find_patient',
        reason: status === 'ambiguous' ? 'ambiguous_lookup' : 'patient_not_found',
        matchCount: matches.length,
      });
      noteIdentityFailure(ctx);
      return {
        status,
        need: missing,
        message:
          status === 'ambiguous'
            ? 'More than one patient matches. Ask for the identifier that is missing.'
            : 'No patient matches those details. Ask the patient to check them.',
      };
    },
  },

  check_availability: {
    description:
      'Get free appointment slots for one provider over a date range, in clinic time. This is the only ' +
      'source of availability: never offer a time that is not in the latest result.',
    input: z.object({
      provider_id: z.string().describe('A provider id from the clinic system note.'),
      date_from: isoDate.describe('First day to search, as YYYY-MM-DD in clinic time.'),
      date_to: isoDate.describe('Last day to search, inclusive. Use date_from for a single day.'),
    }),
    output: z.union([
      z.object({
        provider_id: z.string(),
        provider_name: z.string(),
        timezone: z.string(),
        slots: z.array(SlotView),
      }),
      ToolError,
    ]),
    async run({ provider_id, date_from, date_to }, { deps, tz }) {
      const providers = await deps.calendar.listProviders();
      const provider = providers.find((p) => p.id === provider_id);
      if (!provider) {
        return toolError('unknown_provider', 'No such provider.', { known_providers: providers.map((p) => p.id) });
      }
      if (date_to < date_from) return toolError('invalid_range', 'date_to is before date_from.');
      const slots = await deps.calendar.getAvailability({
        providerId: provider_id,
        from: dayBounds(date_from, tz).start,
        to: dayBounds(date_to, tz).end,
      });
      return {
        provider_id,
        provider_name: provider.name,
        timezone: tz,
        slots: slots.map((s) => ({
          start: toLocalIso(s.start, tz),
          end: toLocalIso(s.end, tz),
          ...displayLabels(s.start, tz),
        })),
      };
    },
  },

  create_booking: {
    gated: true,
    write: true,
    description:
      'Book a slot for the verified patient. Copy `start` exactly from a check_availability result. The ' +
      'result has verified: true only after the booking has been read back from the calendar.',
    input: z.object({
      patient_id: z.string().describe('The id find_patient returned.'),
      provider_id: z.string(),
      start: isoDateTime.describe('The slot start, with its UTC offset, exactly as returned.'),
    }),
    output: WriteOutput,
    async run({ patient_id, provider_id, start }, { deps, tz }) {
      const { calendar, prisma } = deps;
      const patient = await prisma.patient.findUnique({ where: { id: patient_id } });
      if (!patient) return { output: toolError('unknown_patient', 'No such patient.') };
      const providers = await calendar.listProviders();
      if (!providers.some((p) => p.id === provider_id)) {
        return { output: toolError('unknown_provider', 'No such provider.', { known_providers: providers.map((p) => p.id) }) };
      }
      const expected = { patientId: patient_id, providerId: provider_id, start, status: 'active' };

      // Also how a retry stays safe: if a timed-out attempt really did commit, this finds it.
      const existing = await calendar.listBookingsForPatient(patient_id);
      const already = existing.find((b) => b.providerId === provider_id && sameInstant(b.start, start));
      if (already) {
        return {
          output: { booking: bookingView(already, providers, tz), already_booked: true },
          verify: { action: 'create', bookingId: already.id, expected, audit: 'booking.create_idempotent' },
        };
      }

      const clash = findOverlap(existing, start, deps.slotMinutes ?? 30);
      if (clash) {
        return {
          output: toolError(
            'patient_overlap',
            'The patient already has an appointment at that time.',
            { conflicting_booking: bookingView(clash, providers, tz) },
          ),
        };
      }

      const booking = await calendar.createBooking({
        providerId: provider_id,
        start: new Date(start),
        patient: { id: patient.id, name: patient.name, phone: patient.phone },
      });
      return {
        output: { booking: bookingView(booking, providers, tz) },
        verify: { action: 'create', bookingId: booking.id, expected, audit: 'booking.created', compensate: true },
      };
    },
  },

  reschedule_booking: {
    gated: true,
    write: true,
    description:
      "Move one of the verified patient's bookings to a new slot from check_availability. The booking gets " +
      'a new id: use the returned one afterwards. The result has verified: true only after a read-back.',
    input: z.object({
      booking_id: z.string(),
      new_start: isoDateTime.describe('The new slot start, with its UTC offset, exactly as returned.'),
    }),
    output: WriteOutput,
    async run({ booking_id, new_start }, { deps, tz }) {
      const { calendar } = deps;
      const providers = await calendar.listProviders();
      const current = await calendar.getBooking(booking_id);
      if (!current) throw new BookingNotFoundError(booking_id);
      const view = (b) => bookingView(b, providers, tz);
      const expectedFor = (b) => ({ patientId: b.patientId, providerId: b.providerId, start: new_start, status: 'active' });

      if (current.status !== 'active') {
        // A retry after a timeout: the first attempt may already have gone through.
        const moved = current.rescheduledToId && (await calendar.getBooking(current.rescheduledToId));
        if (moved && sameInstant(moved.start, new_start)) {
          return {
            output: { booking: view(moved), previous_booking: view(current), already_rescheduled: true },
            verify: {
              action: 'reschedule',
              bookingId: moved.id,
              previousBookingId: current.id,
              expected: expectedFor(current),
              audit: 'booking.rescheduled',
              before: view(current),
            },
          };
        }
        throw new BookingNotActiveError(booking_id);
      }

      const others = await calendar.listBookingsForPatient(current.patientId);
      const clash = findOverlap(others, new_start, deps.slotMinutes ?? 30, current.id);
      if (clash) {
        return {
          output: toolError(
            'patient_overlap',
            'The patient already has an appointment at that time.',
            { conflicting_booking: view(clash) },
          ),
        };
      }

      const moved = await calendar.rescheduleBooking(booking_id, new Date(new_start), {
        reason: 'Requested by patient via AI receptionist',
      });
      return {
        output: { booking: view(moved), previous_booking: view(current) },
        verify: {
          action: 'reschedule',
          bookingId: moved.id,
          previousBookingId: current.id,
          expected: expectedFor(current),
          audit: 'booking.rescheduled',
          before: view(current),
        },
      };
    },
  },

  cancel_booking: {
    gated: true,
    write: true,
    description:
      "Cancel one of the verified patient's bookings. The result has verified: true only after a read-back.",
    input: z.object({
      booking_id: z.string(),
      reason: z.string().max(300).optional(),
    }),
    output: WriteOutput,
    async run({ booking_id, reason }, { deps, tz }) {
      const { calendar } = deps;
      const providers = await calendar.listProviders();
      const current = await calendar.getBooking(booking_id);
      if (!current) throw new BookingNotFoundError(booking_id);
      const view = (b) => bookingView(b, providers, tz);
      const verify = {
        action: 'cancel',
        bookingId: booking_id,
        expected: { patientId: current.patientId, status: 'cancelled' },
        audit: 'booking.cancelled',
        before: view(current),
      };
      // Also a retry after a timed-out cancel that did go through.
      if (current.status !== 'active') {
        if (current.rescheduledToId) throw new BookingNotActiveError(booking_id);
        return { output: { booking: view(current), already_cancelled: true }, verify };
      }
      const cancelled = await calendar.cancelBooking(booking_id, {
        reason: reason ?? 'Requested by patient via AI receptionist',
      });
      return { output: { booking: view(cancelled) }, verify };
    },
  },

  get_booking: {
    gated: true,
    description: "Read one of the verified patient's bookings by id.",
    input: z.object({ booking_id: z.string() }),
    output: z.union([z.object({ booking: BookingView }), ToolError]),
    async run({ booking_id }, { deps, tz }) {
      const booking = await deps.calendar.getBooking(booking_id);
      if (!booking) throw new BookingNotFoundError(booking_id);
      const providers = await deps.calendar.listProviders();
      return { booking: bookingView(booking, providers, tz) };
    },
  },

  handoff_to_human: {
    description:
      'Pass the conversation to clinic staff. Use it for medical questions, an upset patient, or anything ' +
      'you cannot do. Staff take over and the patient is told automatically, so do not write a reply after it.',
    input: z.object({
      reason: z.enum(['medical_question', 'user_request', 'angry_user', 'cannot_help', 'identity_unresolved', 'other']),
      detail: z.string().max(500).optional().describe('What staff need to know.'),
    }),
    output: z.object({ status: z.literal('handed_off') }),
    async run({ reason, detail }, { turn }) {
      turn.forcedHandoff ??= { reason, detail, source: 'model' };
      return { status: 'handed_off' };
    },
  },
};

/** Frozen at startup: the system prompt and tools must not change within a conversation. */
export const LLM_TOOLS = Object.freeze(
  Object.entries(TOOLS).map(([name, tool]) => {
    const { $schema, ...schema } = z.toJSONSchema(tool.input);
    return { name, description: tool.description, input_schema: schema };
  }),
);
