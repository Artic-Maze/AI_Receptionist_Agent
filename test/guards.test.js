import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeAdapter } from '../src/calendar/fake.js';
import { checkAvailabilityGrounding, loadGrounding } from '../src/guards/availability-grounding.js';
import { verifyBooking } from '../src/guards/booking-verify.js';
import { checkConfirmation } from '../src/guards/confirmation-check.js';
import { checkPatientMessage, handoffMessage, isMisunderstanding } from '../src/guards/handoff-triggers.js';
import { checkIdentityGate } from '../src/guards/identity-gate.js';
import { extractDates, extractTimes, splitClauses } from '../src/guards/text-extract.js';
import { parseLocal } from '../src/time.js';

const TZ = 'Asia/Dhaka';
const NOW = parseLocal('2026-11-04T10:00', TZ);
const at = (local) => parseLocal(local, TZ).toISOString();
const slot = (providerId, local) => ({
  providerId,
  start: at(local),
  end: new Date(new Date(at(local)).getTime() + 30 * 60000).toISOString(),
});
const PROVIDERS = [
  { id: 'dr_karim', name: 'Dr. Karim', nameBn: 'ডা. করিম' },
  { id: 'dr_nasrin', name: 'Dr. Nasrin', nameBn: 'ডা. নাসরিন' },
];

function grounding({ reply, slots = [], bookings = [], patientTexts = [] }) {
  return checkAvailabilityGrounding({
    reply,
    grounding: { slots, bookings },
    patientTexts,
    providers: PROVIDERS,
    now: NOW,
    tz: TZ,
  });
}

describe('text extraction', () => {
  const minutes = (text) => extractTimes(text).map((t) => t.minutes);

  it('reads English times', () => {
    assert.deepEqual(minutes('at 10:30 am'), [[630]]);
    assert.deepEqual(minutes('3pm'), [[900]]);
    assert.deepEqual(minutes('15:00'), [[900]]);
    assert.deepEqual(minutes('10:00'), [[600, 1320]]);
    assert.deepEqual(minutes('at 10 on Tuesday'), [[600, 1320]]);
    assert.deepEqual(minutes("10 o'clock"), [[600, 1320]]);
    assert.deepEqual(minutes('noon'), [[720]]);
  });

  it('reads Bangla times and numerals', () => {
    assert.deepEqual(minutes('সকাল ১০টায়'), [[600]]);
    assert.deepEqual(minutes('বিকাল ৩:৩০'), [[930]]);
    assert.deepEqual(minutes('দুপুর ১২টা'), [[720]]);
    assert.deepEqual(minutes('রাত ৮টা'), [[1200]]);
    assert.deepEqual(minutes('১০:৩০ অপরাহ্ণ'), [[1350]]);
    assert.deepEqual(minutes('সকাল ১০টা থেকে বিকাল ৫টা'), [[600], [1020]]);
  });

  it('does not mistake other numbers for times', () => {
    assert.deepEqual(minutes('+8801711000001'), []);
    assert.deepEqual(minutes('call 999'), []);
    assert.deepEqual(minutes('২টা স্লট আছে'), []);
    assert.deepEqual(minutes('১০ টাকা'), []);
    assert.deepEqual(minutes('on November 10'), []);
    assert.deepEqual(minutes('at 10 November'), []);
    assert.deepEqual(minutes('10:30 amazing'), [[630, 1350]]);
  });

  it('reads dates in both languages', () => {
    const read = (text) => extractDates(text, NOW, TZ).map(({ raw, ...rest }) => rest);
    assert.deepEqual(read('November 10'), [{ month: 11, day: 10 }]);
    assert.deepEqual(read('10th of Nov'), [{ day: 10, month: 11 }]);
    assert.deepEqual(read('১০ নভেম্বর'), [{ day: 10, month: 11 }]);
    assert.deepEqual(read('মঙ্গলবার'), [{ weekday: 2 }]);
    assert.deepEqual(read('Tuesday'), [{ weekday: 2 }]);
    assert.deepEqual(read('Tue, Nov 10'), [{ month: 11, day: 10 }, { weekday: 2 }]);
    assert.deepEqual(read('2026-11-10'), [{ key: '2026-11-10' }]);
    assert.deepEqual(read('tomorrow'), [{ key: '2026-11-05' }]);
    assert.deepEqual(read('আগামীকাল'), [{ key: '2026-11-05' }]);
  });

  it('does not read a following time as part of a date', () => {
    const read = (text) => extractDates(text, NOW, TZ).map(({ raw, ...rest }) => rest);
    assert.deepEqual(read('5 Nov 10 am'), [{ day: 5, month: 11 }]);
    assert.deepEqual(read('৫ নভেম্বর ১০টা'), [{ day: 5, month: 11 }]);
  });

  it('splits on contrast so a refusal cannot shelter an offer', () => {
    const clauses = splitClauses('10:00 is not available, but 11:00 is. Would that work?');
    assert.deepEqual(clauses.map((c) => c.text), ['10:00 is not available', '11:00 is.', 'would that work?']);
    assert.equal(clauses[2].isQuestion, true);
    assert.equal(splitClauses('Dr. Karim has 10:00.').length, 1);
    assert.equal(splitClauses('ডা. করিমের ১০টা খালি আছে।').length, 1);
  });
});

describe('availability grounding', () => {
  const tue10 = slot('dr_karim', '2026-11-10T10:00');
  const wed11 = slot('dr_karim', '2026-11-11T11:00');
  const nasrinTue2 = slot('dr_nasrin', '2026-11-10T14:00');
  const slots = [tue10, wed11, nasrinTue2];

  it('passes a slot that exists', () => {
    assert.equal(grounding({ reply: 'Dr. Karim is free on Tuesday, November 10, at 10:00 AM.', slots }).ok, true);
    assert.equal(grounding({ reply: 'ডা. করিম মঙ্গলবার, ১০ নভেম্বর, সকাল ১০:০০ টায় খালি আছেন।', slots }).ok, true);
  });

  it('catches a time no tool returned', () => {
    const result = grounding({ reply: 'Dr. Karim is free at 9:30 AM on Tuesday.', slots });
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].kind, 'time');
  });

  it('catches any time at all when availability was never checked', () => {
    assert.equal(grounding({ reply: 'Yes, 10:00 AM on Tuesday is available.' }).ok, false);
  });

  it('catches a Bangla hallucination', () => {
    assert.equal(grounding({ reply: 'আগামী মঙ্গলবার সকাল ৯টায় খালি আছে।', slots }).ok, false);
  });

  it('matches date and time as a pair', () => {
    // Tuesday and 11:00 both exist, just not together.
    assert.equal(grounding({ reply: 'Tuesday at 11:00 AM is open.', slots }).ok, false);
  });

  it('matches the provider too', () => {
    // 2 PM on Tuesday exists, but it is Dr. Nasrin's.
    assert.equal(grounding({ reply: 'Dr. Karim is available on Tuesday at 2:00 PM.', slots }).ok, false);
    assert.equal(grounding({ reply: 'Dr. Nasrin is available on Tuesday at 2:00 PM.', slots }).ok, true);
  });

  it('allows saying a time is not available', () => {
    for (const reply of [
      'Sorry, 9:00 AM on Tuesday is no longer available.',
      'Dr. Karim is not available at 9:00 AM on Tuesday.',
      'That slot, 9:00 AM, was just booked by someone else.',
      'দুঃখিত, সকাল ৯টায় কোনো সময় খালি নেই।',
      'ডা. করিম মঙ্গলবার ছুটিতে আছেন।',
    ]) {
      assert.equal(grounding({ reply, slots }).ok, true, reply);
    }
  });

  it('checks an offer made alongside a refusal', () => {
    for (const reply of [
      '9:00 AM is not available, but 9:30 AM is.',
      '9:00 AM is taken, and 9:30 AM is open.',
      'সকাল ৯টায় খালি নেই, সকাল ৯:৩০টায় খালি আছে।',
    ]) {
      assert.equal(grounding({ reply, slots }).ok, false, reply);
    }
    assert.equal(grounding({ reply: 'Tuesday at 9:00 AM is taken, but Wednesday at 11:00 AM is open.', slots }).ok, true);
  });

  it('carries a date down a list of times', () => {
    const reply = 'Dr. Karim on Tuesday, November 10:\n- 10:00 AM\n- 11:00 AM';
    const result = grounding({ reply, slots });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].mention, '11:00 am');
  });

  it('never lets a patient make a slot real by insisting on it', () => {
    const patientTexts = ['I know 9:30 is free, I was told so'];
    assert.equal(grounding({ reply: '9:30 is free, you are right.', slots, patientTexts }).ok, false);
  });

  it('allows a clarifying question that repeats the patient', () => {
    const patientTexts = ['Book me at 9:30'];
    assert.equal(grounding({ reply: 'Which doctor would you like to see at 9:30?', slots, patientTexts }).ok, true);
    assert.equal(grounding({ reply: 'Would 8:30 suit you?', slots, patientTexts }).ok, false);
  });

  it('lets a date be discussed unless it is offered as available', () => {
    assert.equal(grounding({ reply: 'Do you mean next Friday, November 13?', slots }).ok, true);
    assert.equal(grounding({ reply: 'Dr. Karim is available on Friday.', slots }).ok, false);
    assert.equal(grounding({ reply: 'Dr. Karim is available on Tuesday.', slots }).ok, true);
    assert.equal(grounding({ reply: 'ডা. করিম শুক্রবার খালি আছেন।', slots }).ok, false);
  });

  it('accepts times from real bookings', () => {
    const bookings = [slot('dr_karim', '2026-11-12T16:00')];
    assert.equal(grounding({ reply: 'You have an appointment on Thursday at 4:00 PM.', bookings }).ok, true);
    assert.equal(grounding({ reply: 'You have an appointment on Thursday at 5:00 PM.', bookings }).ok, false);
  });

  it('accepts a slot end time', () => {
    assert.equal(grounding({ reply: 'Tuesday 10:00 to 10:30 AM is open.', slots }).ok, true);
  });
});

describe('loadGrounding', () => {
  const start = '2026-11-10T10:00:00+06:00';
  const later = '2026-11-10T11:00:00+06:00';
  const availability = (slots) => ({
    tool: 'check_availability',
    input: {},
    output: { provider_id: 'dr_karim', slots: slots.map((s) => ({ start: s, end: s })) },
  });
  const load = (rows) => loadGrounding({ toolCall: { findMany: async () => rows } }, 'c1');

  it('keeps only the latest result per provider', async () => {
    const { slots } = await load([availability([start, later]), availability([later])]);
    assert.deepEqual(slots.map((s) => s.start), [later]);
  });

  it('forgets a slot once a write finds it taken', async () => {
    const { slots } = await load([
      availability([start, later]),
      { tool: 'create_booking', input: { start }, output: { error: 'slot_unavailable' } },
    ]);
    assert.deepEqual(slots.map((s) => s.start), [later]);
  });

  it('collects bookings from the tools that return them', async () => {
    const booking = { provider_id: 'dr_karim', start, end: later };
    const { bookings } = await load([
      { tool: 'find_patient', input: {}, output: { upcoming_bookings: [booking] } },
      { tool: 'reschedule_booking', input: {}, output: { booking, previous_booking: booking } },
    ]);
    assert.equal(bookings.length, 3);
  });

  it('ignores a booking from a failed write', async () => {
    const { bookings } = await load([
      { tool: 'create_booking', input: {}, output: { error: 'verification_failed', booking: { start } } },
    ]);
    assert.equal(bookings.length, 0);
  });

  describe('active bookings', () => {
    const view = (id, status = 'active', when = start) => ({ id, provider_id: 'dr_karim', start: when, end: when, status });
    const found = { tool: 'find_patient', input: {}, output: { upcoming_bookings: [view('b1')] } };

    it('keeps a booking that still stands', async () => {
      const { activeBookings } = await load([found]);
      assert.deepEqual(activeBookings.map((b) => b.start), [start]);
    });

    it('drops a booking once it is cancelled, while it can still be mentioned', async () => {
      const { activeBookings, bookings } = await load([
        found,
        { tool: 'cancel_booking', input: {}, output: { booking: view('b1', 'cancelled') } },
      ]);
      assert.equal(activeBookings.length, 0);
      assert.equal(bookings.length, 2);
    });

    it('swaps the old booking for the new one after a reschedule', async () => {
      const { activeBookings } = await load([
        found,
        {
          tool: 'reschedule_booking',
          input: {},
          output: { booking: view('b2', 'active', later), previous_booking: view('b1') },
        },
      ]);
      assert.deepEqual(activeBookings.map((b) => b.start), [later]);
    });

    it('adds a newly created booking', async () => {
      const { activeBookings } = await load([
        { tool: 'create_booking', input: {}, output: { booking: view('b3') } },
      ]);
      assert.equal(activeBookings.length, 1);
    });
  });
});

describe('confirmation check', () => {
  const booking = { start: at('2026-11-10T10:00') };
  const created = [{ action: 'create', booking }];
  const check = (reply, verified = []) => checkConfirmation({ reply, verified, now: NOW, tz: TZ });

  it('blocks a claim with no verified write', () => {
    for (const reply of [
      'Your appointment is confirmed for Tuesday.',
      'You are booked with Dr. Karim.',
      "You're booked!",
      'You’re booked!',
      'It’s confirmed.',
      'I have booked you in.',
      "It's confirmed.",
      'Booking confirmed.',
      'Confirmed!',
      'Done! See you on Tuesday.',
      "You're all set.",
      'Don’t worry, your appointment is confirmed.',
      "Don't worry, your appointment is confirmed.",
      'আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত করা হয়েছে।',
      'আপনার অ্যাপয়েন্টমেন্ট বুক করা হয়েছে।',
      'আপনার অ্যাপয়েন্টমেন্ট কনফার্ম।',
    ]) {
      assert.equal(check(reply).ok, false, reply);
    }
  });

  it('allows the claim when verify passed this turn', () => {
    const reply = 'Your appointment is confirmed for Tuesday, November 10, at 10:00 AM.';
    assert.equal(check(reply, created).ok, true);
    assert.equal(check('আপনার অ্যাপয়েন্টমেন্ট মঙ্গলবার সকাল ১০টায় নিশ্চিত করা হয়েছে।', created).ok, true);
  });

  it('does not block honest replies that use the same words', () => {
    for (const reply of [
      'Sorry, that slot was just booked by someone else.',
      'That time is fully booked.',
      'It has not been confirmed yet.',
      "It hasn't been confirmed.",
      'It hasn’t been confirmed.',
      'Would you like me to book it?',
      'I can book that for you.',
      'Once it is confirmed, I will let you know.',
      'If it is confirmed, you will get a message.',
      'Is that time confirmed for you?',
      'I could not confirm your appointment.',
      'অ্যাপয়েন্টমেন্টটি এখনো নিশ্চিত হয়নি।',
      'স্লটটি অন্য কেউ বুক করে দিয়েছেন, তাই নিশ্চিত করা হয়েছে বলা যাচ্ছে না।',
    ]) {
      assert.equal(check(reply).ok, true, reply);
    }
  });

  it('requires the matching kind of write', () => {
    assert.equal(check('Your appointment has been cancelled.', created).ok, false);
    assert.equal(check('Your appointment has been rescheduled.', created).ok, false);
    assert.equal(check('আপনার অ্যাপয়েন্টমেন্ট বাতিল করা হয়েছে।', created).ok, false);
    assert.equal(check('Your appointment has been cancelled.', [{ action: 'cancel', booking }]).ok, true);
  });

  it('catches a claim that states different details from the booking', () => {
    const result = check('Your appointment is confirmed for Tuesday at 11:00 AM.', created);
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].reason, 'details_differ_from_verified_booking');
    assert.equal(check('Your appointment is confirmed for Wednesday at 10:00 AM.', created).ok, false);
  });

  it('allows a reschedule to mention both the old and new time', () => {
    const verified = [{ action: 'reschedule', booking: { start: at('2026-11-11T11:00') }, previous: booking }];
    const reply = 'Your appointment has been moved from Tuesday at 10:00 AM to Wednesday at 11:00 AM.';
    assert.equal(check(reply, verified).ok, true);
  });

  describe('implying an appointment exists, without the word "confirmed"', () => {
    const standing = [{ providerId: 'dr_karim', start: at('2026-11-10T10:00') }];
    const implied = (reply, activeBookings = []) =>
      checkConfirmation({ reply, activeBookings, providers: PROVIDERS, now: NOW, tz: TZ });

    it('blocks it when nothing has been booked', () => {
      for (const reply of [
        'Great, your appointment with Dr. Karim is on Tuesday at 10:00 AM.',
        'Your appointment is at 10:00 AM on Tuesday.',
        'You have an appointment with Dr. Karim on Tuesday at 10:00 AM.',
        'You’ve got an appointment on Tuesday.',
        'We’ll see you on Tuesday at 10:00 AM.',
        'Dr. Karim will see you on Tuesday.',
        'আপনার অ্যাপয়েন্টমেন্ট মঙ্গলবার সকাল ১০টায় আছে।',
        'মঙ্গলবার সকাল ১০টায় আপনার অ্যাপয়েন্টমেন্ট হবে।',
      ]) {
        const result = implied(reply);
        assert.equal(result.ok, false, reply);
      }
    });

    it('allows it when that appointment exists', () => {
      for (const reply of [
        'You have an appointment with Dr. Karim on Tuesday, November 10, 10:00 AM.',
        'You already have an appointment on Tuesday at 10:00 AM.',
        'Your appointment is on Tuesday at 10:00 AM.',
        'You have an appointment.',
        'আপনার অ্যাপয়েন্টমেন্ট মঙ্গলবার সকাল ১০টায় আছে।',
      ]) {
        assert.equal(implied(reply, standing).ok, true, reply);
      }
    });

    it('blocks it when the details differ from the real appointment', () => {
      for (const reply of [
        'You have an appointment on Tuesday at 11:00 AM.',
        'You have an appointment on Wednesday at 10:00 AM.',
        'You have an appointment with Dr. Nasrin on Tuesday at 10:00 AM.',
      ]) {
        const result = implied(reply, standing);
        assert.equal(result.ok, false, reply);
        assert.equal(result.violations[0].reason, 'no_such_appointment');
      }
    });

    it('requires a single appointment to match, not parts of two', () => {
      const two = [
        { providerId: 'dr_karim', start: at('2026-11-10T10:00') },
        { providerId: 'dr_karim', start: at('2026-11-11T11:00') },
      ];
      assert.equal(implied('You have an appointment on Tuesday at 11:00 AM.', two).ok, false);
    });

    it('leaves honest replies alone', () => {
      for (const reply of [
        'You don’t have an appointment on Tuesday.',
        'You have no appointments.',
        'Do you have an appointment already?',
        'If you have an appointment, I can move it.',
        'Would you like an appointment on Tuesday?',
        'আপনার কোনো অ্যাপয়েন্টমেন্ট নেই।',
      ]) {
        assert.equal(implied(reply).ok, true, reply);
      }
    });
  });
});

describe('identity gate', () => {
  const calendar = new FakeAdapter({ clock: () => NOW });
  calendar.seed({ bookings: [{ id: 'bk_mine', patientId: 'p1', providerId: 'dr_karim', start: at('2026-11-10T10:00') }, { id: 'bk_theirs', patientId: 'p2', providerId: 'dr_karim', start: at('2026-11-10T11:00') }] });
  const gate = (patientId, input) =>
    checkIdentityGate({ conversation: { patientId }, toolName: 'x', input, calendar });

  it('blocks when no patient is resolved', async () => {
    assert.equal((await gate(null, { patient_id: 'p1' })).reason, 'no_patient_resolved');
  });

  it('blocks a different patient from the one resolved', async () => {
    assert.equal((await gate('p1', { patient_id: 'p2' })).reason, 'patient_mismatch');
  });

  it('blocks a booking that belongs to someone else', async () => {
    assert.equal((await gate('p1', { booking_id: 'bk_theirs' })).reason, 'booking_not_owned');
  });

  it('passes the resolved patient and their own booking', async () => {
    assert.equal((await gate('p1', { patient_id: 'p1' })).ok, true);
    assert.equal((await gate('p1', { booking_id: 'bk_mine' })).ok, true);
  });

  it('leaves an unknown booking for the tool to report', async () => {
    assert.equal((await gate('p1', { booking_id: 'bk_none' })).ok, true);
  });
});

describe('booking verify', () => {
  const start = at('2026-11-10T10:00');
  const build = () => {
    const calendar = new FakeAdapter({ clock: () => NOW });
    calendar.seed({ bookings: [{ id: 'b1', patientId: 'p1', providerId: 'dr_karim', start }] });
    return calendar;
  };
  const expected = { patientId: 'p1', providerId: 'dr_karim', start, status: 'active' };
  const verify = (overrides, bookingId = 'b1', calendar = build()) =>
    verifyBooking({ calendar, action: 'create', bookingId, expected: { ...expected, ...overrides } });

  it('passes a matching booking', async () => {
    assert.equal((await verify({})).ok, true);
  });

  it('names each mismatch', async () => {
    assert.deepEqual((await verify({ patientId: 'p2' })).mismatches, ['patient']);
    assert.deepEqual((await verify({ providerId: 'dr_x' })).mismatches, ['provider']);
    assert.deepEqual((await verify({ start: at('2026-11-10T11:00') })).mismatches, ['time']);
    assert.deepEqual((await verify({ status: 'cancelled' })).mismatches, ['status']);
  });

  it('compares instants, not strings', async () => {
    assert.equal((await verify({ start: '2026-11-10T10:00:00+06:00' })).ok, true);
  });

  it('fails when the booking is missing', async () => {
    assert.deepEqual((await verify({}, 'nope')).mismatches, ['missing']);
  });

  it('fails when the read-back itself fails', async () => {
    const calendar = { getBooking: async () => { throw new Error('down'); } };
    const result = await verify({}, 'b1', calendar);
    assert.equal(result.ok, false);
    assert.match(result.mismatches[0], /read_back_failed/);
  });

  it('fails a reschedule that left the old booking active', async () => {
    const result = await verifyBooking({
      calendar: build(),
      action: 'reschedule',
      bookingId: 'b1',
      expected,
      previousBookingId: 'b1',
    });
    assert.deepEqual(result.mismatches, ['previous_still_active']);
  });
});

describe('handoff triggers', () => {
  const trigger = (text) => checkPatientMessage(text).trigger;

  it('hands off medical questions', () => {
    for (const text of [
      'Should I take paracetamol before seeing the doctor?',
      'Should I stop my medicine?',
      'What medicine should I take for a headache?',
      'How many tablets can I take?',
      'Is this serious?',
      'What are the side effects?',
      'জ্বরের জন্য কোন ওষুধ খাব?',
    ]) {
      assert.equal(trigger(text), 'medical_question', text);
    }
  });

  it('treats emergencies as emergencies', () => {
    for (const text of ['I have chest pain', "I can't breathe", 'আমার বুকে ব্যথা করছে', 'শ্বাস নিতে পারছি না']) {
      assert.equal(trigger(text), 'medical_emergency', text);
    }
  });

  it('does not hand off an ordinary booking that mentions a symptom or a slot', () => {
    for (const text of [
      'Can I take the 10am slot?',
      'Should I take the Tuesday appointment or Wednesday?',
      'I have a fever, can I see Dr. Karim tomorrow?',
      'Book me with Dr. Karim on Tuesday at 10',
      'I want to cancel my appointment',
      'আগামী মঙ্গলবার ডা. করিমের সাথে অ্যাপয়েন্টমেন্ট চাই',
    ]) {
      assert.equal(checkPatientMessage(text).ok, true, text);
    }
  });

  it('hands off when asked for a person', () => {
    for (const text of [
      'I want to talk to a real person',
      'Can I speak to someone?',
      'Connect me to your manager',
      'human please',
      'আমি একজন মানুষের সাথে কথা বলতে চাই',
    ]) {
      assert.equal(trigger(text), 'user_request', text);
    }
  });

  it('spots a reply that did not understand', () => {
    assert.equal(isMisunderstanding("Sorry, I didn't understand that."), true);
    assert.equal(isMisunderstanding('দুঃখিত, আমি বুঝতে পারিনি।'), true);
    assert.equal(isMisunderstanding('Which doctor would you like?'), false);
  });

  it('writes handoff replies in the patient’s language', () => {
    assert.match(handoffMessage('medical_question', 'en'), /999/);
    assert.match(handoffMessage('medical_question', 'bn'), /৯৯৯/);
    assert.equal(handoffMessage('unknown_reason', 'en'), handoffMessage('default', 'en'));
  });

  it('never lets a code-written reply make a claim of its own', () => {
    const reasons = ['medical_emergency', 'medical_question', 'user_request', 'tool_error', 'booking_verify_failed', 'default', 'holding'];
    for (const reason of reasons) {
      for (const language of ['en', 'bn']) {
        const reply = handoffMessage(reason, language);
        assert.equal(checkConfirmation({ reply, verified: [], now: NOW, tz: TZ }).ok, true, reply);
        assert.equal(grounding({ reply }).ok, true, reply);
      }
    }
  });
});
