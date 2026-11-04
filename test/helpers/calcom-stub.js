// An in-process stand-in for Cal.com API v2, written from its public docs. It lets
// CalcomAdapter's code run here, but it only shows the adapter matches the docs as
// read: `npm run smoke:contract` against a sandbox is what proves it against the real API.

const VERSIONS = { slots: '2024-09-04', booking: '2026-02-25', list: '2026-05-01' };

export function createCalcomStub({ eventTypes, slotMinutes = 30 }) {
  const slots = new Map(Object.entries(eventTypes).map(([id, starts]) => [Number(id), starts]));
  const bookings = new Map();
  const seen = [];
  let nextUid = 1;

  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const requireVersion = (request, expected) => {
    const actual = request.headers.get('cal-api-version');
    if (actual !== expected) throw new Error(`Wrong cal-api-version: ${actual}, expected ${expected}`);
  };
  const isTaken = (eventTypeId, start) =>
    [...bookings.values()].some(
      (b) => b.eventTypeId === eventTypeId && b.status !== 'cancelled' && new Date(b.start).getTime() === new Date(start).getTime(),
    );
  const makeBooking = (fields) => {
    const uid = `uid_${nextUid++}`;
    const end = new Date(new Date(fields.start).getTime() + slotMinutes * 60000).toISOString();
    const booking = { id: nextUid, uid, status: 'accepted', end, ...fields };
    bookings.set(uid, booking);
    return booking;
  };

  async function fetchStub(url, init = {}) {
    const request = new Request(url, init);
    const { pathname, searchParams } = new URL(request.url);
    const path = pathname.replace(/^\/v2/, '');
    seen.push({ method: request.method, path, version: request.headers.get('cal-api-version') });
    if (request.headers.get('authorization') !== 'Bearer cal_test') return json(401, { status: 'error' });
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (request.method === 'GET' && path === '/slots') {
      requireVersion(request, VERSIONS.slots);
      const eventTypeId = Number(searchParams.get('eventTypeId'));
      const from = new Date(searchParams.get('start'));
      const to = new Date(searchParams.get('end'));
      const data = {};
      for (const start of slots.get(eventTypeId) ?? []) {
        const at = new Date(start);
        if (at < from || at >= to || isTaken(eventTypeId, start)) continue;
        const day = start.slice(0, 10);
        const end = new Date(at.getTime() + slotMinutes * 60000).toISOString();
        (data[day] ??= []).push({ start, end });
      }
      return json(200, { status: 'success', data });
    }

    if (request.method === 'POST' && path === '/bookings') {
      requireVersion(request, VERSIONS.booking);
      if (isTaken(body.eventTypeId, body.start)) {
        // Deliberately vague: the docs promise no specific error for this case.
        return json(400, { status: 'error', error: { message: 'no_available_users_found_error' } });
      }
      const booking = makeBooking({
        eventTypeId: body.eventTypeId,
        start: body.start,
        attendees: [{ name: body.attendee.name, email: body.attendee.email }],
        metadata: body.metadata,
      });
      return json(201, { status: 'success', data: booking });
    }

    const rescheduled = /^\/bookings\/([^/]+)\/reschedule$/.exec(path);
    if (request.method === 'POST' && rescheduled) {
      requireVersion(request, VERSIONS.booking);
      const old = bookings.get(rescheduled[1]);
      if (!old) return json(404, { status: 'error' });
      if (isTaken(old.eventTypeId, body.start)) return json(400, { status: 'error', error: { message: 'busy' } });
      // Metadata is not carried over, the worst case the adapter has to survive.
      const moved = makeBooking({
        eventTypeId: old.eventTypeId,
        start: body.start,
        attendees: old.attendees,
        rescheduledFromUid: old.uid,
      });
      old.status = 'cancelled';
      old.rescheduledToUid = moved.uid;
      return json(201, { status: 'success', data: moved });
    }

    const cancelled = /^\/bookings\/([^/]+)\/cancel$/.exec(path);
    if (request.method === 'POST' && cancelled) {
      requireVersion(request, VERSIONS.booking);
      const booking = bookings.get(cancelled[1]);
      if (!booking) return json(404, { status: 'error' });
      booking.status = 'cancelled';
      return json(200, { status: 'success', data: booking });
    }

    const single = /^\/bookings\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && single) {
      requireVersion(request, VERSIONS.booking);
      const booking = bookings.get(single[1]);
      return booking ? json(200, { status: 'success', data: booking }) : json(404, { status: 'error' });
    }

    if (request.method === 'GET' && path === '/bookings') {
      requireVersion(request, VERSIONS.list);
      const email = searchParams.get('attendeeEmail');
      const data = [...bookings.values()].filter(
        (b) => b.status !== 'cancelled' && b.attendees.some((a) => a.email === email),
      );
      return json(200, { status: 'success', data, pagination: { nextCursor: null, hasMore: false } });
    }

    throw new Error(`Unhandled stub route: ${request.method} ${path}`);
  }

  return { fetch: fetchStub, seen, bookings };
}
