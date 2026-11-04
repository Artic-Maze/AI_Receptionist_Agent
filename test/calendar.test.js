import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SlotUnavailableError, TransientCalendarError } from '../src/calendar/adapter.js';
import { CalcomAdapter } from '../src/calendar/calcom.js';
import { FakeAdapter } from '../src/calendar/fake.js';
import { runContract } from '../evals/smoke/contract.js';
import { createCalcomStub } from './helpers/calcom-stub.js';

const NOW = new Date('2026-11-04T04:00:00Z');
const FROM = new Date('2026-11-09T00:00:00Z');
const TO = new Date('2026-11-12T00:00:00Z');
const TUE_10 = '2026-11-10T04:00:00.000Z';
const TUE_1030 = '2026-11-10T04:30:00.000Z';
const TUE_11 = '2026-11-10T05:00:00.000Z';
const PROVIDER = { id: 'dr_karim', name: 'Dr. Karim' };
const PATIENT = { id: 'p1', name: 'Rahim Uddin', phone: '+8801711000001' };

function fake() {
  const adapter = new FakeAdapter({ clock: () => NOW });
  adapter.seed({
    providers: [PROVIDER, { id: 'dr_nasrin', name: 'Dr. Nasrin' }],
    slots: [TUE_10, TUE_1030, TUE_11].map((start) => ({ providerId: 'dr_karim', start })),
  });
  return adapter;
}

describe('calendar contract', () => {
  it('holds for FakeAdapter', async () => {
    const passed = await runContract(fake(), { from: FROM, to: TO });
    assert.equal(passed.length, 9);
  });

  it('holds for CalcomAdapter against the documented API', async () => {
    const stub = createCalcomStub({ eventTypes: { 101: [TUE_10, TUE_1030, TUE_11] } });
    const adapter = new CalcomAdapter({
      apiKey: 'cal_test',
      baseUrl: 'https://api.cal.com/v2',
      providers: [{ ...PROVIDER, eventTypeId: 101 }],
      tz: 'Asia/Dhaka',
      attendeeEmailDomain: 'patients.example.com',
      fetch: stub.fetch,
    });
    const passed = await runContract(adapter, { from: FROM, to: TO });
    assert.equal(passed.length, 9);
    assert.ok(stub.seen.some((r) => r.path === '/slots' && r.version === '2024-09-04'));
  });
});

describe('CalcomAdapter failures', () => {
  const build = (fetchImpl) =>
    new CalcomAdapter({
      apiKey: 'cal_test',
      baseUrl: 'https://api.cal.com/v2',
      providers: [{ ...PROVIDER, eventTypeId: 101 }],
      tz: 'Asia/Dhaka',
      attendeeEmailDomain: 'patients.example.com',
      fetch: fetchImpl,
    });

  it('treats 5xx, 429 and network failures as transient', async () => {
    for (const respond of [
      async () => new Response('', { status: 503 }),
      async () => new Response('', { status: 429 }),
      async () => {
        throw new TypeError('network down');
      },
    ]) {
      await assert.rejects(build(respond).getBooking('x'), TransientCalendarError);
    }
  });

  it('keeps a rejection as-is when the slot is still free', async () => {
    const adapter = build(async (url) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith('/bookings')) {
        return new Response(JSON.stringify({ status: 'error', error: { message: 'bad phone' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ status: 'success', data: { '2026-11-10': [{ start: TUE_10 }] } }));
    });
    await assert.rejects(
      adapter.createBooking({ providerId: 'dr_karim', start: new Date(TUE_10), patient: PATIENT }),
      (error) => error.code === 'calendar_rejected' && !(error instanceof SlotUnavailableError),
    );
  });

  it('accepts slots written as plain strings as well as objects', async () => {
    const adapter = build(
      async () => new Response(JSON.stringify({ status: 'success', data: { '2026-11-10': [TUE_10] } })),
    );
    const slots = await adapter.getAvailability({ providerId: 'dr_karim', from: FROM, to: TO });
    assert.equal(slots[0].start, TUE_10);
  });
});

describe('FakeAdapter fault injection', () => {
  const book = (adapter, start = TUE_10) =>
    adapter.createBooking({ providerId: 'dr_karim', start: new Date(start), patient: PATIENT });

  it('take_slot lets another patient win the race', async () => {
    const adapter = fake();
    adapter.setInjections([{ after_tool: 'check_availability', action: 'take_slot' }]);
    await adapter.onToolEvent('after', 'check_availability', {
      provider_id: 'dr_karim',
      slots: [{ start: TUE_10 }],
    });
    await assert.rejects(book(adapter), SlotUnavailableError);
  });

  it('error fails exactly the requested number of attempts', async () => {
    const adapter = fake();
    adapter.setInjections([{ before_tool: 'create_booking', action: 'error', times: 1 }]);
    await assert.rejects(adapter.onToolEvent('before', 'create_booking'), TransientCalendarError);
    await adapter.onToolEvent('before', 'create_booking');
  });

  it('commit_then_timeout keeps the write but reports a failure', async () => {
    const adapter = fake();
    adapter.setInjections([{ before_tool: 'create_booking', action: 'commit_then_timeout' }]);
    await adapter.onToolEvent('before', 'create_booking');
    await assert.rejects(book(adapter), TransientCalendarError);
    assert.equal((await adapter.listBookingsForPatient('p1')).length, 1);
  });

  it('corrupt_write answers correctly but stores something else', async () => {
    const adapter = fake();
    adapter.setInjections([{ before_tool: 'create_booking', action: 'corrupt_write', field: 'start' }]);
    await adapter.onToolEvent('before', 'create_booking');
    const response = await book(adapter);
    assert.equal(response.start, TUE_10);
    assert.equal((await adapter.getBooking(response.id)).start, TUE_1030);
  });

  it('drop_write reports success without storing anything', async () => {
    const adapter = fake();
    adapter.setInjections([{ before_tool: 'create_booking', action: 'drop_write' }]);
    await adapter.onToolEvent('before', 'create_booking');
    const response = await book(adapter);
    assert.equal(await adapter.getBooking(response.id), null);
  });

  it('never offers a slot that has already passed', async () => {
    const adapter = new FakeAdapter({ clock: () => new Date(TUE_1030) });
    adapter.seed({ providers: [PROVIDER], slots: [TUE_10, TUE_11].map((start) => ({ providerId: 'dr_karim', start })) });
    const slots = await adapter.getAvailability({ providerId: 'dr_karim', from: FROM, to: TO });
    assert.deepEqual(slots.map((s) => s.start), [TUE_11]);
  });
});
