// Proves CalcomAdapter behaves like FakeAdapter by running the same checks against
// both. The evals only trust FakeAdapter because this contract holds.
//
//   npm run smoke:contract   needs CALCOM_API_KEY and CALCOM_PROVIDERS; creates and
//                            cancels one real booking in the configured sandbox.

import { pathToFileURL } from 'node:url';

import { CalcomAdapter } from '../../src/calendar/calcom.js';
import { BookingNotActiveError, SlotUnavailableError } from '../../src/calendar/adapter.js';
import { config } from '../../src/config.js';

const same = (a, b) => new Date(a).getTime() === new Date(b).getTime();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * @param {import('../../src/calendar/adapter.js').CalendarAdapter} adapter
 * @param {{ from: Date, to: Date, patient?: { id: string, name: string, phone: string },
 *           log?: (name: string) => void }} options
 */
export async function runContract(adapter, { from, to, patient, log = () => {} }) {
  const who = patient ?? { id: 'contract_patient', name: 'Contract Test', phone: '+8801700000000' };
  const passed = [];
  const check = (name) => {
    passed.push(name);
    log(name);
  };

  const providers = await adapter.listProviders();
  assert(providers.length > 0 && providers.every((p) => p.id && p.name), 'providers need id and name');
  const providerId = providers[0].id;
  check('lists providers');

  const slots = await adapter.getAvailability({ providerId, from, to });
  assert(slots.length >= 2, `need two free slots for ${providerId} to run the contract`);
  assert(
    slots.every((s, i) => s.providerId === providerId && (i === 0 || new Date(slots[i - 1].start) <= new Date(s.start))),
    'slots must carry the provider and be sorted',
  );
  check('returns sorted availability');

  const [first, second] = slots;
  let live;
  try {
    const created = await adapter.createBooking({ providerId, start: new Date(first.start), patient: who });
    live = created.id;
    assert(created.id, 'created booking needs an id');
    assert(created.patientId === who.id, `patient: ${created.patientId}`);
    assert(created.providerId === providerId, `provider: ${created.providerId}`);
    assert(same(created.start, first.start), `start: ${created.start}`);
    assert(created.status === 'active', `status: ${created.status}`);
    check('creates a booking');

    const readBack = await adapter.getBooking(created.id);
    assert(readBack && readBack.patientId === who.id && readBack.providerId === providerId, 'read-back mismatch');
    assert(same(readBack.start, first.start), 'read-back start mismatch');
    check('reads a booking back');

    const after = await adapter.getAvailability({ providerId, from, to });
    assert(!after.some((s) => same(s.start, first.start)), 'a booked slot must leave availability');
    let rejected = false;
    try {
      await adapter.createBooking({
        providerId,
        start: new Date(first.start),
        patient: { ...who, id: `${who.id}_other`, name: 'Contract Other' },
      });
    } catch (error) {
      rejected = error instanceof SlotUnavailableError;
      if (!rejected) throw error;
    }
    assert(rejected, 'double-booking a slot must raise SlotUnavailableError');
    check('rejects a double booking');

    const listed = await adapter.listBookingsForPatient(who.id);
    assert(listed.some((b) => b.id === created.id), 'patient listing must include the booking');
    check('lists a patient’s bookings');

    const moved = await adapter.rescheduleBooking(created.id, new Date(second.start), { reason: 'contract test' });
    live = moved.id;
    assert(moved.id !== created.id, 'a reschedule must return a new booking id');
    assert(same(moved.start, second.start), `moved start: ${moved.start}`);
    const movedBack = await adapter.getBooking(moved.id);
    assert(movedBack.patientId === who.id, `patient after reschedule: ${movedBack.patientId}`);
    assert(movedBack.providerId === providerId, `provider after reschedule: ${movedBack.providerId}`);
    assert(same(movedBack.start, second.start), 'moved read-back start mismatch');
    const old = await adapter.getBooking(created.id);
    assert(!old || old.status !== 'active', 'the old booking must not stay active');
    check('reschedules to a new id and retires the old one');

    const cancelled = await adapter.cancelBooking(moved.id, { reason: 'contract test' });
    live = null;
    assert(cancelled.status === 'cancelled', `cancel status: ${cancelled.status}`);
    const gone = await adapter.getBooking(moved.id);
    assert(gone.status === 'cancelled', `cancel read-back: ${gone.status}`);
    const remaining = await adapter.listBookingsForPatient(who.id);
    assert(!remaining.some((b) => b.id === moved.id), 'a cancelled booking must leave the listing');
    let again = false;
    try {
      await adapter.cancelBooking(moved.id);
    } catch (error) {
      again = error instanceof BookingNotActiveError;
      if (!again) throw error;
    }
    assert(again, 'cancelling twice must raise BookingNotActiveError');
    check('cancels and reads the cancellation back');

    assert((await adapter.getBooking('does-not-exist-000')) === null, 'an unknown id must return null');
    check('returns null for an unknown booking');
  } finally {
    if (live) await adapter.cancelBooking(live, { reason: 'contract test cleanup' }).catch(() => {});
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { calcom } = config.calendar;
  if (!calcom.apiKey || !calcom.providers.length) {
    console.error('Set CALCOM_API_KEY and CALCOM_PROVIDERS to run the contract against a real sandbox.');
    process.exit(2);
  }
  const adapter = new CalcomAdapter({ ...calcom, tz: config.tz });
  const from = new Date(Date.now() + 24 * 3600_000);
  const to = new Date(Date.now() + 15 * 24 * 3600_000);
  const passed = await runContract(adapter, { from, to, log: (name) => console.log(`  ok  ${name}`) });
  console.log(`Contract passed against Cal.com: ${passed.length} checks.`);
}
