import { dayBounds, localParts } from '../time.js';
import {
  BookingNotActiveError,
  BookingNotFoundError,
  CalendarError,
  SlotUnavailableError,
  TransientCalendarError,
} from './adapter.js';

// Cal.com API v2 pins behaviour per endpoint through this header. Without it the
// API silently falls back to an older version of the endpoint.
const VERSION = {
  slots: '2024-09-04',
  booking: '2026-02-25',
  listBookings: '2026-05-01',
};

const TIMEOUT_MS = 10_000;

const iso = (value) => new Date(value).toISOString();

/** @implements {import('./adapter.js').CalendarAdapter} */
export class CalcomAdapter {
  #apiKey;
  #baseUrl;
  #providers;
  #tz;
  #fetch;
  #emailDomain;

  constructor({ apiKey, baseUrl, providers, tz, attendeeEmailDomain, fetch: fetchImpl }) {
    if (!apiKey) throw new Error('CalcomAdapter needs CALCOM_API_KEY');
    if (!providers?.length) throw new Error('CalcomAdapter needs CALCOM_PROVIDERS');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#providers = providers;
    this.#tz = tz;
    this.#emailDomain = attendeeEmailDomain;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  /** Synthetic and deterministic: this is how a patient's bookings are found again. */
  #attendeeEmail(patientId) {
    return `patient-${patientId}@${this.#emailDomain}`;
  }

  async #request(method, path, { version, query, body } = {}) {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'cal-api-version': version,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new TransientCalendarError('Could not reach Cal.com.', { cause });
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientCalendarError(`Cal.com returned ${response.status}.`);
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Handled by the status checks below.
    }
    if (!response.ok || payload?.status === 'error') {
      const error = new CalendarError(
        'calendar_rejected',
        payload?.error?.message ?? payload?.message ?? `Cal.com returned ${response.status}.`,
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  #providerByEventType(eventTypeId) {
    return this.#providers.find((p) => Number(p.eventTypeId) === Number(eventTypeId));
  }

  #eventTypeId(providerId) {
    const provider = this.#providers.find((p) => p.id === providerId);
    if (!provider) throw new CalendarError('unknown_provider', `Unknown provider ${providerId}.`);
    return provider.eventTypeId;
  }

  #mapBooking(data) {
    if (Array.isArray(data)) {
      throw new CalendarError('unsupported_booking', 'Recurring bookings are not supported.');
    }
    const eventTypeId = data.eventTypeId ?? data.eventType?.id;
    // Metadata may not survive a reschedule, so the attendee email is the backup.
    const fromEmail = data.attendees
      ?.map((a) => /^patient-(.+)@/.exec(a.email ?? '')?.[1])
      .find(Boolean);
    return {
      id: data.uid,
      patientId: data.metadata?.patientId ?? fromEmail ?? null,
      providerId: this.#providerByEventType(eventTypeId)?.id ?? data.metadata?.providerId ?? null,
      start: iso(data.start),
      end: iso(data.end),
      status: data.status === 'cancelled' || data.status === 'rejected' ? 'cancelled' : 'active',
      rescheduledFromId: data.rescheduledFromUid ?? undefined,
      rescheduledToId: data.rescheduledToUid ?? undefined,
    };
  }

  async listProviders() {
    return this.#providers.map(({ id, name, nameBn, specialty }) => ({
      id,
      name,
      nameBn,
      specialty,
    }));
  }

  async getAvailability({ providerId, from, to }) {
    const { data } = await this.#request('GET', '/slots', {
      version: VERSION.slots,
      query: {
        eventTypeId: this.#eventTypeId(providerId),
        start: iso(from),
        end: iso(to),
        timeZone: this.#tz,
        format: 'range',
      },
    });
    const slots = [];
    for (const day of Object.values(data ?? {})) {
      for (const entry of day) {
        // Cal.com's schema says strings while its examples show objects: accept both.
        const start = typeof entry === 'string' ? entry : entry.start;
        const end = typeof entry === 'string' ? undefined : entry.end;
        if (!start) continue;
        slots.push({ providerId, start: iso(start), end: end ? iso(end) : iso(start) });
      }
    }
    return slots.sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  /**
   * Cal.com does not document an error for a taken slot, so wording can't be
   * relied on. After a rejection, ask the calendar whether the slot is still free.
   */
  async #explainRejection(error, providerId, start) {
    if (!(error instanceof CalendarError) || error.transient) throw error;
    const { dateKey } = localParts(start, this.#tz);
    const { start: from, end: to } = dayBounds(dateKey, this.#tz);
    const free = await this.getAvailability({ providerId, from, to });
    const stillFree = free.some((s) => new Date(s.start).getTime() === new Date(start).getTime());
    if (!stillFree) throw new SlotUnavailableError();
    throw error;
  }

  async createBooking({ providerId, start, patient }) {
    try {
      const { data } = await this.#request('POST', '/bookings', {
        version: VERSION.booking,
        body: {
          start: iso(start),
          eventTypeId: this.#eventTypeId(providerId),
          attendee: {
            name: patient.name,
            email: this.#attendeeEmail(patient.id),
            timeZone: this.#tz,
            ...(patient.phone ? { phoneNumber: patient.phone } : {}),
          },
          metadata: { patientId: patient.id, providerId },
        },
      });
      return this.#mapBooking(data);
    } catch (error) {
      return this.#explainRejection(error, providerId, start);
    }
  }

  async rescheduleBooking(id, newStart, { reason } = {}) {
    const current = await this.getBooking(id);
    if (!current) throw new BookingNotFoundError(id);
    if (current.status !== 'active') throw new BookingNotActiveError(id);
    try {
      const { data } = await this.#request('POST', `/bookings/${encodeURIComponent(id)}/reschedule`, {
        version: VERSION.booking,
        body: { start: iso(newStart), ...(reason ? { reschedulingReason: reason } : {}) },
      });
      return this.#mapBooking(data);
    } catch (error) {
      return this.#explainRejection(error, current.providerId, newStart);
    }
  }

  async cancelBooking(id, { reason } = {}) {
    const current = await this.getBooking(id);
    if (!current) throw new BookingNotFoundError(id);
    if (current.status !== 'active') throw new BookingNotActiveError(id);
    const { data } = await this.#request('POST', `/bookings/${encodeURIComponent(id)}/cancel`, {
      version: VERSION.booking,
      body: reason ? { cancellationReason: reason } : {},
    });
    return this.#mapBooking(data);
  }

  async getBooking(id) {
    try {
      const { data } = await this.#request('GET', `/bookings/${encodeURIComponent(id)}`, {
        version: VERSION.booking,
      });
      return data ? this.#mapBooking(data) : null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listBookingsForPatient(patientId) {
    const { data } = await this.#request('GET', '/bookings', {
      version: VERSION.listBookings,
      query: {
        attendeeEmail: this.#attendeeEmail(patientId),
        status: 'upcoming',
        sortStart: 'asc',
        limit: 100,
      },
    });
    return (data ?? [])
      .filter((b) => !Array.isArray(b))
      .map((b) => this.#mapBooking(b))
      .filter((b) => b.status === 'active' && b.patientId === patientId);
  }
}
