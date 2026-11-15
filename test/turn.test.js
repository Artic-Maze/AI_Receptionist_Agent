import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { detectLanguage } from '../src/agent/state.js';
import { MAX_TOOL_CALLS_PER_TURN, runTurn } from '../src/agent/turn.js';
import { MAX_REGISTRATIONS } from '../src/tools/index.js';
import { createTestPrisma, migrateTestDatabase } from '../evals/lib/db.js';
import { at, RAHIM, setup } from './helpers/harness.js';

const IDENTIFY = { call: 'find_patient', input: { name: 'Rahim Uddin', dob: '1985-03-12' } };
const CHECK = { call: 'check_availability', input: { provider_id: 'dr_karim', date_from: '2026-11-10', date_to: '2026-11-10' } };
const BOOK = { call: 'create_booking', input: { patient_id: 'p1', provider_id: 'dr_karim', start: '2026-11-10T10:00:00+06:00' } };
const CONFIRMED = 'Your appointment with Dr. Karim is confirmed for Tuesday, November 10, 10:00 AM.';

describe('agent turn', () => {
  let prisma;

  before(async () => {
    await migrateTestDatabase();
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  const fired = (result, guard) => result.guardResults.filter((g) => g.guard === guard && !g.ok);

  it('books, verifies and only then confirms', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([IDENTIFY, CHECK, BOOK, { say: CONFIRMED }]);
    const result = await runTurn(deps, { conversationId, text: 'Book me with Dr. Karim on Tuesday at 10' });

    assert.equal(result.reply, CONFIRMED);
    assert.equal(result.handedOff, false);
    const [booking] = await calendar.listBookingsForPatient('p1');
    assert.equal(new Date(booking.start).getTime(), at('2026-11-10T10:00').getTime());
    const actions = (await prisma.auditLog.findMany({ orderBy: { id: 'asc' } })).map((a) => a.action);
    assert.deepEqual(actions, ['booking.created', 'turn.completed']);
    assert.equal(await prisma.toolCall.count(), 3);
  });

  it('keeps the replay history append-only and valid across turns', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'Could I have your full name and date of birth?' }]);
    await runTurn(deps, { conversationId, text: 'I need an appointment' });
    llm.load([IDENTIFY, { say: 'Thank you, Rahim. Which doctor?' }]);
    await runTurn(deps, { conversationId, text: 'Rahim Uddin, 12 March 1985' });
    // A later turn, so the tool call above has to come back from the database.
    llm.load([{ say: 'Which day would you like?' }]);
    await runTurn(deps, { conversationId, text: 'Dr. Karim' });

    const [first, second, third, fourth] = llm.requests;
    // Each request must start with exactly the messages of the one before, byte for
    // byte. This compares strings on purpose: deepEqual ignores key order, and key
    // order surviving the database is the whole reason messages are stored as json.
    assert.equal(JSON.stringify(second.slice(0, first.length)), JSON.stringify(first));
    assert.equal(JSON.stringify(third.slice(0, second.length)), JSON.stringify(second));
    assert.equal(JSON.stringify(fourth.slice(0, third.length)), JSON.stringify(third));
    const toolUse = fourth.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_use');
    assert.deepEqual(Object.keys(toolUse.input), ['name', 'dob']);
    assert.equal(first[0].role, 'user');
    assert.equal(first[1].role, 'system');
    // A tool round stays paired, and a system note always follows a user message.
    for (const request of [first, second, third, fourth]) {
      request.forEach((message, i) => {
        if (message.role === 'system') assert.equal(request[i - 1].role, 'user');
        if (Array.isArray(message.content) && message.content[0]?.type === 'tool_use') {
          assert.equal(request[i + 1].content[0].tool_use_id, message.content[0].id);
        }
      });
    }
  });

  it('regenerates a bad reply once and never shows the draft', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    const bad = 'Yes, Dr. Karim is free at 9:00 AM on Tuesday.';
    const good = 'I need your full name and date of birth first.';
    llm.load([{ say: bad }, { say: good }]);
    const result = await runTurn(deps, { conversationId, text: 'Is Dr. Karim free?' });

    assert.equal(result.reply, good);
    assert.equal(fired(result, 'availability_grounding').length, 1);
    const shown = await prisma.message.findMany({ where: { role: 'assistant', kind: { in: ['chat', 'display'] } } });
    assert.deepEqual(shown.map((m) => m.content[0].text), [good]);
    // The correction went in as a system note straight after a user message.
    const regenRequest = llm.requests[1];
    assert.equal(regenRequest.at(-1).role, 'system');
    assert.match(regenRequest.at(-1).content, /not sent to the patient/);
    assert.equal(regenRequest.at(-2).role, 'user');
  });

  it('hands off when the regenerated reply also fails', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'He is free at 9:00 AM on Tuesday.' }, { say: 'He is free at 9:30 AM on Tuesday.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Is Dr. Karim free?' });

    assert.equal(result.handedOff, true);
    assert.equal(result.handoffReason, 'guard_failure');
    assert.doesNotMatch(result.reply, /9:/);
    assert.equal((await prisma.handoff.findFirst()).reason, 'guard_failure');
  });

  it('never calls the model about a medical question', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    const result = await runTurn(deps, { conversationId, text: 'Should I take paracetamol before my visit?' });
    assert.equal(result.handoffReason, 'medical_question');
    assert.equal(llm.requests.length, 0);
    assert.match(result.reply, /medical advice/);
  });

  it('keeps the agent out once staff have the conversation', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    await runTurn(deps, { conversationId, text: 'I want to talk to a real person' });
    const result = await runTurn(deps, { conversationId, text: 'Hello? Can you book me in?' });
    assert.equal(result.status, 'handed_off');
    assert.equal(result.handedOff, true);
    assert.equal(llm.requests.length, 0);
    assert.match(result.reply, /staff/);
  });

  it('writes a handoff from the model’s tool call without another model call', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ call: 'handoff_to_human', input: { reason: 'angry_user', detail: 'Patient is upset' } }]);
    const result = await runTurn(deps, { conversationId, text: 'This is ridiculous.' });
    assert.equal(result.handoffReason, 'angry_user');
    assert.equal(llm.requests.length, 1);
    assert.equal((await prisma.handoff.findFirst()).detail, 'Patient is upset');
  });

  for (const [name, step, reason] of [
    ['a refusal', { stop: 'refusal' }, 'llm_refusal'],
    ['a cut-off reply', { stop: 'max_tokens' }, 'llm_max_tokens'],
    ['an API failure', { throw: 'overloaded' }, 'llm_error'],
  ]) {
    it(`hands off on ${name}`, async () => {
      const { deps, llm, conversationId } = await setup(prisma);
      llm.load([step]);
      const result = await runTurn(deps, { conversationId, text: 'Hello' });
      assert.equal(result.handoffReason, reason);
      assert.equal(result.status, 'handed_off');
    });
  }

  it('hands off on an empty reply that stays empty', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: '' }, { say: '' }]);
    const result = await runTurn(deps, { conversationId, text: 'Hello' });
    assert.equal(result.handoffReason, 'guard_failure');
  });

  it('stops at the tool-call limit', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load(Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, () => CHECK));
    const result = await runTurn(deps, { conversationId, text: 'Check everything' });
    assert.equal(result.handoffReason, 'tool_limit');
    assert.equal(await prisma.toolCall.count(), MAX_TOOL_CALLS_PER_TURN);
  });

  it('treats a repeated webhook delivery as a no-op', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'Hello!' }]);
    await runTurn(deps, { conversationId, text: 'Hi', externalId: 'wamid.1' });
    const repeat = await runTurn(deps, { conversationId, text: 'Hi', externalId: 'wamid.1' });
    assert.equal(repeat.duplicate, true);
    assert.equal(llm.requests.length, 1);
  });

  it('runs concurrent messages one at a time', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'First reply.' }, { say: 'Second reply.' }]);
    const [one, two] = await Promise.all([
      runTurn(deps, { conversationId, text: 'First' }),
      runTurn(deps, { conversationId, text: 'Second' }),
    ]);
    assert.equal(one.reply, 'First reply.');
    assert.equal(two.reply, 'Second reply.');
    const secondRequest = llm.requests[1];
    assert.ok(secondRequest.some((m) => m.content?.[0]?.text === 'First reply.'));
  });

  it('follows the language the patient writes in', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'Hello.' }, { say: 'নমস্কার।' }, { say: 'ঠিক আছে।' }]);
    await runTurn(deps, { conversationId, text: 'Hello' });
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).language, 'en');
    await runTurn(deps, { conversationId, text: 'আমি বাংলায় কথা বলতে চাই' });
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).language, 'bn');
    await runTurn(deps, { conversationId, text: '১০' });
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).language, 'bn');
    assert.match(llm.requests[1].at(-1).content, /Reply in: Bangla/);
  });

  it('follows a patient into Spanish, and back to English', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ say: 'Hola. ¿En qué puedo ayudarle?' }, { say: 'De acuerdo.' }, { say: 'Sure.' }]);
    const language = async () => (await prisma.conversation.findUnique({ where: { id: conversationId } })).language;
    await runTurn(deps, { conversationId, text: 'Hola, quiero una cita' });
    assert.equal(await language(), 'es');
    assert.match(llm.requests[0].at(-1).content, /Reply in: Spanish/);
    // A name alone says nothing about language, so Spanish stays.
    await runTurn(deps, { conversationId, text: 'Rahim Uddin' });
    assert.equal(await language(), 'es');
    await runTurn(deps, { conversationId, text: 'Can we speak English instead?' });
    assert.equal(await language(), 'en');
  });

  it('books in Spanish, and confirms only what was verified', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    const confirmed = 'Su cita con el Dr. Karim está confirmada para el martes, 10 de noviembre, a las 10:00 a. m.';
    llm.load([IDENTIFY, CHECK, BOOK, { say: confirmed }]);
    const result = await runTurn(deps, {
      conversationId,
      text: 'Soy Rahim Uddin, nací el 12 de marzo de 1985. Quiero una cita con el Dr. Karim el martes a las 10.',
    });
    assert.equal(result.reply, confirmed);
    assert.equal(result.handedOff, false);
    assert.equal((await calendar.listBookingsForPatient('p1')).length, 1);
  });

  it('holds Spanish replies to the same guards, and hands off in Spanish', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([
      { say: 'Su cita con el Dr. Karim está confirmada para el martes a las 10:00 a. m.' },
      { say: 'Listo, su cita ha quedado reservada.' },
    ]);
    const result = await runTurn(deps, { conversationId, text: 'Resérveme con el Dr. Karim el martes a las 10, por favor' });
    assert.equal(result.handedOff, true);
    assert.equal(result.handoffReason, 'guard_failure');
    assert.match(result.reply, /Le pongo en contacto con un miembro de nuestro personal/);
    assert.equal(calendar.snapshot().length, 0);
  });

  it('puts the clinic time and verified patient in the turn note', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([IDENTIFY, { say: 'Hi Rahim.' }, { say: 'Which doctor?' }]);
    await runTurn(deps, { conversationId, text: 'Rahim Uddin, 12 March 1985' });
    await runTurn(deps, { conversationId, text: 'I need an appointment' });
    const firstNote = llm.requests[0].at(-1).content;
    const laterNote = llm.requests[2].at(-1).content;
    assert.match(firstNote, /Wednesday, November 4, 10:00 AM, 2026/);
    assert.match(firstNote, /Verified patient: none yet/);
    assert.match(laterNote, /Verified patient: p1 \(Rahim Uddin\)/);
  });
});

describe('tool execution', () => {
  let prisma;
  before(() => {
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  const toolOutput = async (name) => {
    const row = await prisma.toolCall.findFirst({ where: { tool: name }, orderBy: { id: 'desc' } });
    return row;
  };

  it('rejects invalid input before touching the calendar', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([IDENTIFY, { call: 'create_booking', input: { patient_id: 'p1', provider_id: 'dr_karim', start: 'Tuesday at 10' } }, { say: 'Sorry, one moment.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, book Tuesday 10' });
    assert.equal(fired(result, 'input_validation').length, 1);
    assert.equal((await toolOutput('create_booking')).error, 'invalid_input');
    assert.equal(calendar.snapshot().length, 0);
  });

  it('rejects a slot that is missing a UTC offset', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([IDENTIFY, { ...BOOK, input: { ...BOOK.input, start: '2026-11-10T10:00:00' } }, { say: 'Sorry, one moment.' }]);
    await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12' });
    assert.equal((await toolOutput('create_booking')).error, 'invalid_input');
    assert.equal(calendar.snapshot().length, 0);
  });

  it('reports an unknown tool to the model without crashing', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ call: 'delete_everything' }, { say: 'Sorry, I can’t do that.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Do something' });
    assert.equal(result.handedOff, false);
    assert.equal((await toolOutput('delete_everything')).error, 'unknown_tool');
  });

  it('asks twice for identity, then hands off', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    const miss = { call: 'find_patient', input: { name: 'Nobody Here', dob: '2000-01-01' } };
    const ask = { say: 'I could not find you. Please check your details.' };
    llm.load([miss, ask]);
    assert.equal((await runTurn(deps, { conversationId, text: 'Nobody Here, 1 Jan 2000' })).handedOff, false);
    llm.load([miss, ask]);
    assert.equal((await runTurn(deps, { conversationId, text: 'Still Nobody Here' })).handedOff, false);
    llm.load([miss]);
    const third = await runTurn(deps, { conversationId, text: 'I told you, Nobody Here' });
    assert.equal(third.handoffReason, 'identity_unresolved');
  });

  it('requires two identifiers, even when one matches a single patient', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ call: 'find_patient', input: { name: 'Rahim Uddin' } }, BOOK, { say: 'I need your date of birth too.' }]);
    const result = await runTurn(deps, { conversationId, text: 'I am Rahim Uddin, book me in' });
    assert.equal(JSON.parse(JSON.stringify((await toolOutput('find_patient')).output)).status, 'needs_more_info');
    assert.equal(fired(result, 'identity_gate')[0].reason, 'no_patient_resolved');
  });

  it('uses the channel phone as an identifier', async () => {
    const { deps, llm, conversationId } = await setup(prisma, { channel: 'whatsapp', callerPhone: RAHIM.phone });
    llm.load([{ call: 'find_patient', input: { name: 'Rahim' } }, { say: 'Hello Rahim.' }]);
    await runTurn(deps, { conversationId, text: 'This is Rahim' });
    assert.equal((await toolOutput('find_patient')).output.status, 'resolved');
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).patientId, 'p1');
  });

  it('finds a relative on another number by name and date of birth', async () => {
    const son = { id: 'p2', name: 'Arif Uddin', phone: '+8801000000009', dob: '2015-06-01' };
    const { deps, llm, conversationId } = await setup(prisma, { patients: [RAHIM, son], channel: 'whatsapp', callerPhone: RAHIM.phone });
    llm.load([{ call: 'find_patient', input: { name: 'Arif Uddin', dob: '2015-06-01' } }, { say: 'Thanks.' }]);
    await runTurn(deps, { conversationId, text: 'It is for my son Arif Uddin, born 1 June 2015' });
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).patientId, 'p2');
  });

  it('forgets the current patient when a new lookup fails', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([IDENTIFY, { say: 'Hello Rahim.' }]);
    await runTurn(deps, { conversationId, text: 'Rahim Uddin, 12 March 1985' });
    llm.load([{ call: 'find_patient', input: { name: 'Unknown Son', dob: '2015-01-01' } }, BOOK, { say: 'I could not find your son.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Book my son Unknown Son, born 1 Jan 2015' });
    assert.equal(fired(result, 'identity_gate').at(-1).reason, 'no_patient_resolved');
    assert.equal(calendar.snapshot().length, 0);
  });

  it('does not reveal other patients in an ambiguous lookup', async () => {
    const twin = { ...RAHIM, id: 'p2', dob: '1990-01-01' };
    const { deps, llm, conversationId } = await setup(prisma, { patients: [RAHIM, twin] });
    llm.load([{ call: 'find_patient', input: { name: 'Rahim Uddin' } }, { say: 'What is your date of birth?' }]);
    await runTurn(deps, { conversationId, text: 'Rahim Uddin' });
    const { output } = await toolOutput('find_patient');
    assert.equal(output.status, 'ambiguous');
    assert.doesNotMatch(JSON.stringify(output), /1985|1990|p1|p2|\+880/);
  });

  it('handles Bangla numerals in a phone number', async () => {
    const { normalizePhone } = await import('../src/tools/identity.js');
    assert.equal(normalizePhone('০১০০০-০০০০০১'), RAHIM.phone);
    assert.equal(normalizePhone('8801000000001'), RAHIM.phone);
    assert.equal(normalizePhone('+8801000000001'), RAHIM.phone);
  });

  it('finds a patient by their Bangla name', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([{ call: 'find_patient', input: { name: 'রহিম উদ্দিন', dob: '1985-03-12' } }, { say: 'ধন্যবাদ।' }]);
    await runTurn(deps, { conversationId, text: 'আমি রহিম উদ্দিন' });
    assert.equal((await toolOutput('find_patient')).output.status, 'resolved');
  });

  it('undoes a new booking that fails verification', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    calendar.setInjections([{ before_tool: 'create_booking', action: 'corrupt_write', field: 'start' }]);
    llm.load([IDENTIFY, CHECK, BOOK]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, Tuesday at 10' });

    assert.equal(result.handoffReason, 'booking_verify_failed');
    assert.deepEqual(fired(result, 'booking_verify')[0].mismatches, ['time']);
    assert.equal((await calendar.listBookingsForPatient('p1')).length, 0);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'booking.verify_failed' } });
    assert.equal(audit.after.undone, true);
    assert.equal(audit.patientId, 'p1');
  });

  it('leaves a failed reschedule for staff rather than losing the appointment', async () => {
    const bookings = [{ id: 'bk_seed', patientId: 'p1', providerId: 'dr_karim', start: at('2026-11-10T10:00') }];
    const { deps, llm, calendar, conversationId } = await setup(prisma, {
      slots: ['2026-11-10T10:00', '2026-11-11T11:00'],
      bookings,
    });
    calendar.setInjections([{ before_tool: 'reschedule_booking', action: 'corrupt_write', field: 'start' }]);
    llm.load([IDENTIFY, { call: 'reschedule_booking', input: { booking_id: 'bk_seed', new_start: '2026-11-11T11:00:00+06:00' } }]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, move it to Wednesday at 11' });

    assert.equal(result.handoffReason, 'booking_verify_failed');
    assert.match((await prisma.handoff.findFirst()).detail, /Left for staff/);
    assert.equal((await calendar.listBookingsForPatient('p1')).length, 1);
  });

  it('survives a timeout whose write actually went through', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    calendar.setInjections([{ before_tool: 'create_booking', action: 'commit_then_timeout' }]);
    llm.load([IDENTIFY, CHECK, BOOK, { say: CONFIRMED }]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, Tuesday at 10' });

    assert.equal(result.reply, CONFIRMED);
    assert.equal((await calendar.listBookingsForPatient('p1')).length, 1);
    assert.equal((await toolOutput('create_booking')).output.already_booked, true);
  });

  it('hands off after a failed retry, without a model call', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    calendar.setInjections([{ before_tool: 'create_booking', action: 'error', times: 2 }]);
    llm.load([IDENTIFY, BOOK]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, Tuesday at 10' });
    assert.equal(result.handoffReason, 'tool_error');
    assert.equal(llm.requests.length, 2);
    assert.equal(calendar.snapshot().length, 0);
  });

  it('records a rejected write in the audit log', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    calendar.setInjections([{ after_tool: 'check_availability', action: 'take_slot' }]);
    llm.load([IDENTIFY, CHECK, BOOK, { say: 'Sorry, that time was just taken. Tuesday, November 10, 10:30 AM is free.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, Tuesday at 10' });
    assert.equal(result.handedOff, false);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'booking.create_rejected' } }));
  });

  it('undoes the calendar write if the audit entry cannot be saved', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    const failing = new Proxy(prisma, {
      get(target, key) {
        if (key === '$transaction') {
          return async () => {
            throw new Error('database down');
          };
        }
        return target[key];
      },
    });
    llm.load([IDENTIFY, CHECK, BOOK]);
    const result = await runTurn(
      { ...deps, prisma: failing },
      { conversationId, text: 'Rahim Uddin 1985-03-12, Tuesday at 10' },
    );
    assert.equal(result.handoffReason, 'audit_write_failed');
    assert.equal((await calendar.listBookingsForPatient('p1')).length, 0);
    assert.doesNotMatch(result.reply, /confirmed/i);
  });

  it('never lets one patient read another’s booking', async () => {
    const other = { ...RAHIM, id: 'p2', name: 'Fatema Begum', dob: '1990-01-01', phone: '+8801000000004' };
    const bookings = [{ id: 'bk_theirs', patientId: 'p2', providerId: 'dr_karim', start: at('2026-11-10T10:00') }];
    const { deps, llm, conversationId } = await setup(prisma, { patients: [RAHIM, other], bookings });
    llm.load([IDENTIFY, { call: 'get_booking', input: { booking_id: 'bk_theirs' } }, { say: 'I can’t see that booking.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Rahim Uddin 1985-03-12, what is bk_theirs?' });
    assert.equal(fired(result, 'identity_gate')[0].reason, 'booking_not_owned');
    const row = await toolOutput('get_booking');
    assert.equal(row.output.error, 'identity_gate_blocked');
    assert.doesNotMatch(JSON.stringify(row.output), /Fatema|p2|10:00/);
  });

  const fired = (result, guard) => result.guardResults.filter((g) => g.guard === guard && !g.ok);
});

describe('language detection', () => {
  it('tells Spanish from English by its words, and Bangla by its script', () => {
    assert.equal(detectLanguage('Hola, quiero una cita con el Dr. Karim', 'en'), 'es');
    assert.equal(detectLanguage('Sí', 'en'), 'es');
    assert.equal(detectLanguage('¿Y el martes?', 'en'), 'es');
    assert.equal(detectLanguage('Book me with Dr. Karim on Tuesday at 10', 'es'), 'en');
    assert.equal(detectLanguage('Hi, I’m José García, born 3 March 1990', 'es'), 'en');
    assert.equal(detectLanguage('আমি রহিম উদ্দিন', 'es'), 'bn');
  });

  it('keeps the conversation’s language when a message gives no evidence', () => {
    assert.equal(detectLanguage('Rahim Uddin', 'es'), 'es');
    assert.equal(detectLanguage('Rahim Uddin', 'en'), 'en');
    assert.equal(detectLanguage('10:30', 'es'), 'es');
    assert.equal(detectLanguage('Ok, gracias', 'en'), 'es');
    // Latin script with no evidence is English, as it was before Spanish existed.
    assert.equal(detectLanguage('OK', 'bn'), 'en');
  });
});

describe('registration', () => {
  let prisma;
  before(async () => {
    await migrateTestDatabase();
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  const NADIA = { name: 'Nadia Islam', dob: '1992-07-03', phone: '01712345678' };
  const register = (input) => ({ call: 'register_patient', input });
  const lastOutput = async (tool) =>
    (await prisma.toolCall.findFirst({ where: { tool }, orderBy: { id: 'desc' } })).output;
  const conversationOf = (id) => prisma.conversation.findUnique({ where: { id } });

  it('registers a new patient, who can then book straight away', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([
      { call: 'find_patient', input: { name: NADIA.name, dob: NADIA.dob } },
      { say: 'I couldn’t find you. Are you new to the clinic?' },
    ]);
    await runTurn(deps, { conversationId, text: 'Nadia Islam, born 3 July 1992' });
    llm.load([register(NADIA), { say: 'Thank you, Nadia, you are registered now. Which doctor would you like to see?' }]);
    const registered = await runTurn(deps, { conversationId, text: 'Yes, I’m new. My number is 01712345678' });

    assert.equal(registered.handedOff, false);
    const patient = await prisma.patient.findFirst({ where: { name: NADIA.name } });
    assert.equal(patient.phone, '+8801712345678');
    assert.equal(patient.dob, NADIA.dob);
    assert.equal(patient.demo, false);
    assert.equal((await conversationOf(conversationId)).patientId, patient.id);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'patient.registered', patientId: patient.id } }));

    const book = { call: 'create_booking', input: { patient_id: patient.id, provider_id: 'dr_karim', start: '2026-11-10T10:00:00+06:00' } };
    llm.load([CHECK, book, { say: CONFIRMED }]);
    const booked = await runTurn(deps, { conversationId, text: 'Dr. Karim on Tuesday at 10, please' });
    assert.equal(booked.reply, CONFIRMED);
    assert.equal((await calendar.listBookingsForPatient(patient.id)).length, 1);
  });

  it('will not register anyone over an existing patient', async () => {
    const { deps, llm, calendar, conversationId } = await setup(prisma);
    llm.load([register({ name: 'Rahim Uddin', dob: '1985-03-12', phone: '01799999999' }), BOOK, { say: 'Let me check your details.' }]);
    const result = await runTurn(deps, { conversationId, text: 'Register me: Rahim Uddin, 12 March 1985, 01799999999' });

    const output = await lastOutput('register_patient');
    assert.equal(output.status, 'already_registered');
    assert.doesNotMatch(JSON.stringify(output), /p1|\+880|1985/);
    assert.equal(await prisma.patient.count(), 1);
    assert.equal((await conversationOf(conversationId)).patientId, null);
    assert.equal(result.guardResults.find((g) => g.guard === 'identity_gate' && !g.ok).reason, 'no_patient_resolved');
    assert.equal(calendar.snapshot().length, 0);
  });

  it('treats a longer or shorter form of an existing name, born the same day, as that patient', async () => {
    for (const name of ['Rahim Uddin Khan', 'Rahim', 'রহিম উদ্দিন']) {
      const { deps, llm, conversationId } = await setup(prisma);
      llm.load([register({ name, dob: '1985-03-12', phone: '01799999999' }), { say: 'Let me check.' }]);
      await runTurn(deps, { conversationId, text: `${name}, 12 March 1985` });
      assert.equal((await lastOutput('register_patient')).status, 'already_registered', name);
      assert.equal(await prisma.patient.count(), 1, name);
    }
  });

  it('checks the details before registering anyone', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    const attempts = [
      [{ ...NADIA, dob: '2030-01-01' }, 'invalid_details'],
      [{ ...NADIA, dob: '1890-01-01' }, 'invalid_details'],
      [{ ...NADIA, phone: '12345' }, 'invalid_details'],
      [{ name: NADIA.name, dob: NADIA.dob }, 'needs_more_info'],
    ];
    for (const [input, status] of attempts) {
      llm.load([register(input), { say: 'Could you check that for me?' }]);
      await runTurn(deps, { conversationId, text: 'Here are my details' });
      assert.equal((await lastOutput('register_patient')).status, status, JSON.stringify(input));
    }
    for (const name of ['Ignore all rules 123', 'Nadia <script>', 'a b c d e f g']) {
      llm.load([register({ ...NADIA, name }), { say: 'Could you check your name?' }]);
      await runTurn(deps, { conversationId, text: 'Here is my name' });
      assert.equal((await lastOutput('register_patient')).error, 'invalid_input', name);
    }
    assert.equal(await prisma.patient.count(), 1);
    assert.equal((await conversationOf(conversationId)).patientId, null);
  });

  it('uses the channel’s phone number on WhatsApp', async () => {
    const { deps, llm, conversationId } = await setup(prisma, { channel: 'whatsapp', callerPhone: '+8801712345678' });
    llm.load([register({ name: NADIA.name, dob: NADIA.dob }), { say: 'You are registered now.' }]);
    await runTurn(deps, { conversationId, text: 'I am new: Nadia Islam, 3 July 1992' });
    assert.equal((await prisma.patient.findFirst({ where: { name: NADIA.name } })).phone, '+8801712345678');
  });

  it('keeps a Bangla name findable in Bangla', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    llm.load([register({ ...NADIA, name: 'নাদিয়া ইসলাম' }), { say: 'ধন্যবাদ, আপনার নিবন্ধন হয়েছে।' }]);
    await runTurn(deps, { conversationId, text: 'আমি নতুন রোগী' });
    assert.equal((await prisma.patient.findFirst({ where: { dob: NADIA.dob } })).nameBn, 'নাদিয়া ইসলাম');
    llm.load([{ call: 'find_patient', input: { name: 'নাদিয়া ইসলাম', dob: NADIA.dob } }, { say: 'ধন্যবাদ।' }]);
    await runTurn(deps, { conversationId, text: 'আবার আমি' });
    assert.equal((await lastOutput('find_patient')).status, 'resolved');
  });

  it('caps registrations per conversation', async () => {
    const { deps, llm, conversationId } = await setup(prisma);
    const names = ['Nadia Islam', 'Sumi Islam', 'Tania Islam', 'Mitu Islam'];
    llm.load([...names.map((name) => register({ ...NADIA, name })), { say: 'Thank you.' }]);
    await runTurn(deps, { conversationId, text: 'Register my whole family' });
    assert.equal(await prisma.patient.count(), 1 + MAX_REGISTRATIONS);
    assert.equal((await lastOutput('register_patient')).status, 'limit_reached');
  });
});

describe('audit log', () => {
  let prisma;
  before(() => {
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  it('rejects any change to existing rows', async () => {
    await setup(prisma);
    const row = await prisma.auditLog.create({ data: { actor: 'test', action: 'original' } });
    await assert.rejects(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }), /append-only/);
    await assert.rejects(prisma.auditLog.delete({ where: { id: row.id } }), /append-only/);
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE audit_log'), /append-only/);
    assert.equal((await prisma.auditLog.findUnique({ where: { id: row.id } })).action, 'original');
  });

  it('keeps its truncate trigger after an eval reset', async () => {
    await setup(prisma);
    await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE audit_log'), /append-only/);
  });
});
