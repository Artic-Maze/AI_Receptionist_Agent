// The calendar sits behind this interface so the evals can swap in FakeAdapter.
//
// A reschedule returns a NEW booking id and retires the old one. Cal.com behaves
// this way (rescheduledFromUid / rescheduledToUid), so FakeAdapter must too, or
// the evals would hide bugs that only appear in production.

/**
 * @typedef {{ id: string, name: string, nameBn?: string, specialty?: string }} Provider
 * @typedef {{ providerId: string, start: string, end: string }} Slot  ISO instants
 * @typedef {{
 *   id: string, patientId: string, providerId: string,
 *   start: string, end: string, status: 'active' | 'cancelled',
 *   rescheduledFromId?: string, rescheduledToId?: string,
 * }} Booking
 *
 * @typedef {object} CalendarAdapter
 * @property {() => Promise<Provider[]>} listProviders
 * @property {(q: { providerId: string, from: Date, to: Date }) => Promise<Slot[]>} getAvailability
 * @property {(b: { providerId: string, start: Date, patient: { id: string, name: string, phone?: string } }) => Promise<Booking>} createBooking
 * @property {(id: string, newStart: Date, opts?: { reason?: string }) => Promise<Booking>} rescheduleBooking
 * @property {(id: string, opts?: { reason?: string }) => Promise<Booking>} cancelBooking
 * @property {(id: string) => Promise<Booking | null>} getBooking
 * @property {(patientId: string) => Promise<Booking[]>} listBookingsForPatient  upcoming, active only
 */

export class CalendarError extends Error {
  /** @param {string} code  machine-readable, shown to the model */
  constructor(code, message, { transient = false, cause } = {}) {
    super(message, { cause });
    this.name = 'CalendarError';
    this.code = code;
    this.transient = transient;
  }
}

export class SlotUnavailableError extends CalendarError {
  constructor(message = 'That time is not available.') {
    super('slot_unavailable', message);
  }
}

export class BookingNotFoundError extends CalendarError {
  constructor(id) {
    super('booking_not_found', `No booking with id ${id}.`);
  }
}

export class BookingNotActiveError extends CalendarError {
  constructor(id) {
    super('booking_not_active', `Booking ${id} is no longer active.`);
  }
}

/** Timeouts, 5xx, 429: the write may or may not have happened. */
export class TransientCalendarError extends CalendarError {
  constructor(message = 'The calendar is not responding.', options = {}) {
    super('calendar_unavailable', message, { ...options, transient: true });
  }
}
