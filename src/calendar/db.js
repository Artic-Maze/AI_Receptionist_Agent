import { addDays, dayBounds, localParts, parseLocal, weekdayOf } from '../time.js';
import {
  BookingNotActiveError,
  BookingNotFoundError,
  CalendarError,
  SlotUnavailableError,
  TransientCalendarError,
} from './adapter.js';

const iso = (value) => new Date(value).toISOString();
const ms = (value) => new Date(value).getTime();
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Postgres reports a unique violation, here a second active booking for one slot. */
const isUniqueViolation = (error) => error?.code === 'P2002' || error?.cause?.code === '23505';

function toBooking(row) {
  return {
    id: row.id,
    patientId: row.patientId,
    providerId: row.providerId,
    start: iso(row.start),
    end: iso(row.end),
    status: row.status,
    ...(row.rescheduledFromId ? { rescheduledFromId: row.rescheduledFromId } : {}),
    ...(row.rescheduledToId ? { rescheduledToId: row.rescheduledToId } : {}),
  };
}

/**
 * The demo calendar, kept in Postgres: doctors, their weekly hours, and bookings.
 * Slots are cut from the weekly hours on demand, so the schedule never runs out
 * and never needs reseeding. It must pass the same contract as CalcomAdapter.
 *
 * @implements {import('./adapter.js').CalendarAdapter}
 */
export class DbCalendarAdapter {
  #prisma;
  #tz;
  #clock;
  #slotMinutes;
  #horizonDays;

  /**
   * @param {object} options
   * @param {number} [options.horizonDays]  how far ahead patients can book
   */
  constructor({ prisma, tz, clock = () => new Date(), slotMinutes = 30, horizonDays = 90 }) {
    this.#prisma = prisma;
    this.#tz = tz;
    this.#clock = clock;
    this.#slotMinutes = slotMinutes;
    this.#horizonDays = horizonDays;
  }

  /** A database failure may or may not have committed, as with a timeout. */
  async #guard(task) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw new TransientCalendarError('The calendar database is not responding.', { cause: error });
    }
  }

  async listProviders() {
    return this.#guard(async () => {
      const rows = await this.#prisma.provider.findMany({ orderBy: { name: 'asc' } });
      return rows.map(({ id, name, nameBn, specialty }) => ({
        id,
        name,
        ...(nameBn ? { nameBn } : {}),
        ...(specialty ? { specialty } : {}),
      }));
    });
  }

  /** Every provider's weekly hours, for the homepage. Not part of the adapter contract. */
  async weeklyHours() {
    return this.#guard(async () => {
      const rows = await this.#prisma.providerHours.findMany({
        orderBy: [{ providerId: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
      });
      return rows.map((row) => ({
        providerId: row.providerId,
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      }));
    });
  }

  /** Every slot the weekly hours allow in [from, to), booked or not, from now up to the horizon. */
  #scheduledSlots(providerId, hours, from, to) {
    const now = this.#clock();
    const lower = Math.max(ms(from), ms(now));
    const upper = Math.min(ms(to), ms(now) + this.#horizonDays * 86_400_000);
    if (lower >= upper) return [];
    const slots = [];
    const last = localParts(new Date(upper - 1), this.#tz).dateKey;
    for (let day = localParts(new Date(lower), this.#tz).dateKey; day <= last; day = addDays(day, 1)) {
      const weekday = weekdayOf(day);
      for (const block of hours) {
        if (block.weekday !== weekday) continue;
        for (let m = block.startMinute; m + this.#slotMinutes <= block.endMinute; m += this.#slotMinutes) {
          const start = parseLocal(`${day}T${hhmm(m)}`, this.#tz);
          if (ms(start) > ms(now) && ms(start) >= lower && ms(start) < upper) {
            slots.push({ providerId, start: iso(start), end: iso(ms(start) + this.#slotMinutes * 60_000) });
          }
        }
      }
    }
    return slots.sort((a, b) => ms(a.start) - ms(b.start));
  }

  async #freeSlots(providerId, from, to) {
    const hours = await this.#prisma.providerHours.findMany({ where: { providerId } });
    const slots = this.#scheduledSlots(providerId, hours, from, to);
    if (!slots.length) return [];
    const booked = await this.#prisma.calendarBooking.findMany({
      where: {
        providerId,
        status: 'active',
        start: { lt: new Date(slots.at(-1).end) },
        end: { gt: new Date(slots[0].start) },
      },
    });
    return slots.filter((slot) => !booked.some((b) => overlaps(b, slot)));
  }

  /** The free slot starting at exactly this instant, if there is one. */
  async #freeSlotAt(providerId, start) {
    const { start: from, end: to } = dayBounds(localParts(start, this.#tz).dateKey, this.#tz);
    const free = await this.#freeSlots(providerId, from, to);
    return free.find((slot) => ms(slot.start) === ms(start)) ?? null;
  }

  async getAvailability({ providerId, from, to }) {
    return this.#guard(() => this.#freeSlots(providerId, from, to));
  }

  async createBooking({ providerId, start, patient }) {
    return this.#guard(async () => {
      const slot = await this.#freeSlotAt(providerId, start);
      if (!slot) throw new SlotUnavailableError();
      try {
        const row = await this.#prisma.calendarBooking.create({
          data: { patientId: patient.id, providerId, start: new Date(slot.start), end: new Date(slot.end) },
        });
        return toBooking(row);
      } catch (error) {
        // Someone else took the slot between the check above and this insert.
        if (isUniqueViolation(error)) throw new SlotUnavailableError();
        throw error;
      }
    });
  }

  async rescheduleBooking(id, newStart) {
    return this.#guard(async () => {
      const current = await this.#prisma.calendarBooking.findUnique({ where: { id } });
      if (!current) throw new BookingNotFoundError(id);
      if (current.status !== 'active') throw new BookingNotActiveError(id);
      const slot = await this.#freeSlotAt(current.providerId, newStart);
      if (!slot) throw new SlotUnavailableError();
      try {
        // One transaction, so a failure leaves the original booking exactly as it was.
        const moved = await this.#prisma.$transaction(async (tx) => {
          const retired = await tx.calendarBooking.updateMany({
            where: { id, status: 'active' },
            data: { status: 'cancelled' },
          });
          if (retired.count === 0) throw new BookingNotActiveError(id);
          const created = await tx.calendarBooking.create({
            data: {
              patientId: current.patientId,
              providerId: current.providerId,
              start: new Date(slot.start),
              end: new Date(slot.end),
              rescheduledFromId: id,
            },
          });
          await tx.calendarBooking.update({ where: { id }, data: { rescheduledToId: created.id } });
          return created;
        });
        return toBooking(moved);
      } catch (error) {
        if (isUniqueViolation(error)) throw new SlotUnavailableError();
        throw error;
      }
    });
  }

  async cancelBooking(id) {
    return this.#guard(async () => {
      const current = await this.#prisma.calendarBooking.findUnique({ where: { id } });
      if (!current) throw new BookingNotFoundError(id);
      if (current.status !== 'active') throw new BookingNotActiveError(id);
      // Conditional, so two cancels racing can't both report success.
      const { count } = await this.#prisma.calendarBooking.updateMany({
        where: { id, status: 'active' },
        data: { status: 'cancelled' },
      });
      if (count === 0) throw new BookingNotActiveError(id);
      return toBooking({ ...current, status: 'cancelled' });
    });
  }

  async getBooking(id) {
    return this.#guard(async () => {
      const row = await this.#prisma.calendarBooking.findUnique({ where: { id } });
      return row ? toBooking(row) : null;
    });
  }

  async listBookingsForPatient(patientId) {
    return this.#guard(async () => {
      const rows = await this.#prisma.calendarBooking.findMany({
        where: { patientId, status: 'active', start: { gt: this.#clock() } },
        orderBy: { start: 'asc' },
      });
      return rows.map(toBooking);
    });
  }
}
