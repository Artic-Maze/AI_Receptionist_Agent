import {
  BookingNotActiveError,
  BookingNotFoundError,
  SlotUnavailableError,
  TransientCalendarError,
} from './adapter.js';

const iso = (value) => new Date(value).toISOString();
const ms = (value) => new Date(value).getTime();
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);

/**
 * In-memory calendar with the same behaviour as CalcomAdapter, plus fault
 * injection on cue: races, errors, empty results and silently corrupted writes.
 *
 * @implements {import('./adapter.js').CalendarAdapter}
 */
export class FakeAdapter {
  #providers = [];
  #slots = [];
  #bookings = [];
  #injections = [];
  #armed = [];
  #nextId = 1;
  #clock;
  #slotMinutes;

  constructor({ clock = () => new Date(), slotMinutes = 30 } = {}) {
    this.#clock = clock;
    this.#slotMinutes = slotMinutes;
  }

  /** Dates here are instants; callers convert wall-clock values first. */
  seed({ providers = [], slots = [], bookings = [] }) {
    this.#providers = providers.map((p) => ({ ...p }));
    this.#slots = slots.map((s) => {
      const start = iso(s.start);
      const end = s.end ? iso(s.end) : iso(ms(start) + this.#slotMinutes * 60000);
      return { providerId: s.providerId, start, end };
    });
    this.#bookings = bookings.map((b) => {
      const start = iso(b.start);
      return {
        id: b.id,
        patientId: b.patientId,
        providerId: b.providerId,
        start,
        end: b.end ? iso(b.end) : iso(ms(start) + this.#slotMinutes * 60000),
        status: b.status ?? 'active',
      };
    });
  }

  /**
   * @param {Array<{ before_tool?: string, after_tool?: string, action: string,
   *   times?: number, slot?: { providerId: string, start: Date }, field?: string }>} injections
   */
  setInjections(injections = []) {
    this.#injections = injections.map((i) => ({ ...i, remaining: i.times ?? 1 }));
    this.#armed = [];
  }

  /** Called by the tool executor around each attempt; real adapters don't define it. */
  async onToolEvent(phase, tool, output) {
    for (const injection of this.#injections) {
      const cue = phase === 'before' ? injection.before_tool : injection.after_tool;
      if (cue !== tool || injection.remaining <= 0) continue;
      injection.remaining -= 1;
      switch (injection.action) {
        case 'error':
          throw new TransientCalendarError('Injected calendar outage.');
        case 'take_slot':
          this.#takeSlot(injection.slot, output);
          break;
        case 'empty_result':
        case 'commit_then_timeout':
        case 'corrupt_write':
        case 'drop_write':
          this.#armed.push(injection);
          break;
        default:
          throw new Error(`Unknown injection action: ${injection.action}`);
      }
    }
  }

  #takeSlot(slot, output) {
    const target = slot
      ? { providerId: slot.providerId, start: iso(slot.start) }
      : output?.slots?.[0] && { providerId: output.provider_id, start: iso(output.slots[0].start) };
    if (!target) throw new Error('take_slot had nothing to take');
    this.#bookings.push({
      id: `bk_other_${this.#nextId++}`,
      patientId: 'someone_else',
      providerId: target.providerId,
      start: target.start,
      end: iso(ms(target.start) + this.#slotMinutes * 60000),
      status: 'active',
    });
  }

  #disarm(action) {
    const index = this.#armed.findIndex((i) => i.action === action);
    if (index < 0) return null;
    return this.#armed.splice(index, 1)[0];
  }

  #findSlot(providerId, start) {
    return this.#slots.find((s) => s.providerId === providerId && ms(s.start) === ms(start));
  }

  #isFree(slot) {
    return !this.#bookings.some(
      (b) => b.status === 'active' && b.providerId === slot.providerId && overlaps(b, slot),
    );
  }

  /** Stores the booking, applying any armed fault to what is actually persisted. */
  #commit(booking) {
    const dropped = this.#disarm('drop_write');
    const corrupt = this.#disarm('corrupt_write');
    const timeout = this.#disarm('commit_then_timeout');
    const stored = { ...booking };
    if (corrupt) {
      if (corrupt.field === 'start') {
        const shifted = ms(stored.start) + this.#slotMinutes * 60000;
        stored.start = iso(shifted);
        stored.end = iso(shifted + this.#slotMinutes * 60000);
      } else if (corrupt.field === 'provider') {
        const other = this.#providers.find((p) => p.id !== stored.providerId);
        stored.providerId = other?.id ?? 'unknown_provider';
      } else if (corrupt.field === 'patient') {
        stored.patientId = corrupt.patient_id ?? 'wrong_patient';
      } else {
        throw new Error(`Unknown corrupt_write field: ${corrupt.field}`);
      }
    }
    if (!dropped) this.#bookings.push(stored);
    if (timeout) throw new TransientCalendarError('Injected timeout after the write committed.');
    // The response looks right even when what was stored is not: only a
    // read-back can tell the difference.
    return { ...booking };
  }

  async listProviders() {
    return this.#providers.map((p) => ({ ...p }));
  }

  async getAvailability({ providerId, from, to }) {
    if (this.#disarm('empty_result')) return [];
    const now = this.#clock().getTime();
    return this.#slots
      .filter(
        (s) =>
          s.providerId === providerId &&
          ms(s.start) >= ms(from) &&
          ms(s.start) < ms(to) &&
          ms(s.start) > now &&
          this.#isFree(s),
      )
      .sort((a, b) => ms(a.start) - ms(b.start))
      .map((s) => ({ ...s }));
  }

  async createBooking({ providerId, start, patient }) {
    const slot = this.#findSlot(providerId, start);
    if (!slot || !this.#isFree(slot)) throw new SlotUnavailableError();
    return this.#commit({
      id: `bk_${this.#nextId++}`,
      patientId: patient.id,
      providerId,
      start: slot.start,
      end: slot.end,
      status: 'active',
    });
  }

  async rescheduleBooking(id, newStart) {
    const current = this.#bookings.find((b) => b.id === id);
    if (!current) throw new BookingNotFoundError(id);
    if (current.status !== 'active') throw new BookingNotActiveError(id);
    const slot = this.#findSlot(current.providerId, newStart);
    if (!slot || !this.#isFree(slot)) throw new SlotUnavailableError();
    const newId = `bk_${this.#nextId++}`;
    current.status = 'cancelled';
    current.rescheduledToId = newId;
    return this.#commit({
      id: newId,
      patientId: current.patientId,
      providerId: current.providerId,
      start: slot.start,
      end: slot.end,
      status: 'active',
      rescheduledFromId: id,
    });
  }

  async cancelBooking(id) {
    const current = this.#bookings.find((b) => b.id === id);
    if (!current) throw new BookingNotFoundError(id);
    if (current.status !== 'active') throw new BookingNotActiveError(id);
    const dropped = this.#disarm('drop_write');
    if (!dropped) current.status = 'cancelled';
    if (this.#disarm('commit_then_timeout')) {
      throw new TransientCalendarError('Injected timeout after the write committed.');
    }
    return { ...current, status: 'cancelled' };
  }

  async getBooking(id) {
    const booking = this.#bookings.find((b) => b.id === id);
    return booking ? { ...booking } : null;
  }

  async listBookingsForPatient(patientId) {
    const now = this.#clock().getTime();
    return this.#bookings
      .filter((b) => b.patientId === patientId && b.status === 'active' && ms(b.start) > now)
      .sort((a, b) => ms(a.start) - ms(b.start))
      .map((b) => ({ ...b }));
  }

  /** For evals: every booking, including other patients' and cancelled ones. */
  snapshot() {
    return this.#bookings.map((b) => ({ ...b }));
  }

  /** For evals: slots still free, as of now. */
  freeSlots() {
    const now = this.#clock().getTime();
    return this.#slots.filter((s) => ms(s.start) > now && this.#isFree(s)).map((s) => ({ ...s }));
  }
}
