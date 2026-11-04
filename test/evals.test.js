import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { evaluateChecks, effectiveExpect } from '../evals/lib/checks.js';
import { assertTestDatabase, createTestPrisma, migrateTestDatabase } from '../evals/lib/db.js';
import { runScenario } from '../evals/lib/run-scenario.js';
import { assertPlannedCoverage, loadScenarios } from '../evals/lib/scenarios.js';
import { findRegressions } from '../evals/lib/suite.js';

const TZ = 'Asia/Dhaka';

const minimalScenario = (overrides = {}) => ({
  id: 'x',
  category: 'happy_path',
  language: 'en',
  description: 'x',
  seed: { patients: [{ id: 'p1', name: 'A', phone: '+1', dob: '2000-01-01' }], slots: [], bookings: [] },
  inject: [],
  turns: [{ user: 'hi', script: [] }],
  expect: {},
  ...overrides,
});

const minimalRun = (overrides = {}) => ({
  crash: null,
  turns: [{ user: 'hi', reply: 'Hello', guards: [] }],
  toolCalls: [],
  audit: [],
  handoffs: [],
  conversations: [{ status: 'active', patientId: null }],
  calendar: [],
  freeSlots: [],
  scriptRemaining: 0,
  scriptExhausted: false,
  ...overrides,
});

const failed = (checks) => checks.filter((c) => !c.pass).map((c) => c.name);

describe('golden dataset', () => {
  it('matches the planned size of each category', async () => {
    const scenarios = await loadScenarios();
    assert.equal(scenarios.length, 46);
    assertPlannedCoverage(scenarios);
  });

  it('notices if the dataset drifts from the plan', async () => {
    const scenarios = await loadScenarios();
    assert.throws(() => assertPlannedCoverage(scenarios.slice(1)), /drifted/);
    assert.throws(() => assertPlannedCoverage(scenarios.map((s) => ({ ...s, core: false }))), /core set/);
  });

  it('has unique ids', async () => {
    const scenarios = await loadScenarios();
    assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  });

  it('rejects a mistyped field instead of silently checking nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenario-'));
    await writeFile(
      join(directory, 'typo.yaml'),
      'id: typo\ncategory: handoff\nlanguage: en\ndescription: x\nseed: {}\nturns: [{ user: hi }]\nexpect: { must_not_sey: [x] }\n',
    );
    await assert.rejects(loadScenarios(directory), /Invalid scenario typo\.yaml[\s\S]*must_not_sey/);
  });

  it('rejects a mistyped calendar expectation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenario-'));
    await writeFile(
      join(directory, 'typo.yaml'),
      'id: typo\ncategory: handoff\nlanguage: en\ndescription: x\nseed: {}\nturns: [{ user: hi }]\nexpect: { final_calendar: { booking_for_p1: 1 } }\n',
    );
    await assert.rejects(loadScenarios(directory), /booking_for_p1/);
  });

  it('rejects an id that does not match its file name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenario-'));
    await writeFile(
      join(directory, 'other.yaml'),
      'id: typo\ncategory: handoff\nlanguage: en\ndescription: x\nseed: {}\nturns: [{ user: hi }]\nexpect: {}\n',
    );
    await assert.rejects(loadScenarios(directory), /does not match/);
  });
});

describe('test database safety', () => {
  it('refuses anything not named as a test database', () => {
    for (const url of ['postgresql://localhost/receptionist', 'postgresql://localhost/faffly', 'postgresql://localhost/test_receptionist']) {
      assert.throws(() => assertTestDatabase(url), /Refusing to run/);
    }
    assert.throws(() => assertTestDatabase(undefined), /not set/);
    assert.equal(assertTestDatabase('postgresql://localhost/receptionist_test'), 'postgresql://localhost/receptionist_test');
  });
});

describe('checks', () => {
  const check = (expect, run = {}, overrides = {}) =>
    evaluateChecks({ scenario: minimalScenario({ expect, ...overrides }), mode: 'claude', run: minimalRun(run), tz: TZ });

  const booking = (fields = {}) => ({
    patientId: 'p1',
    providerId: 'dr_karim',
    start: '2026-11-10T04:00:00.000Z',
    status: 'active',
    ...fields,
  });

  it('fails on a crash', () => {
    assert.deepEqual(failed(check({}, { crash: 'boom' })), ['no_crash']);
  });

  it('counts only active bookings', () => {
    const calendar = [booking(), booking({ status: 'cancelled' })];
    assert.deepEqual(failed(check({ final_calendar: { bookings_for_p1: 1, total_active: 1 } }, { calendar })), []);
    assert.deepEqual(failed(check({ final_calendar: { bookings_for_p1: 0 } }, { calendar })), ['calendar.bookings_for_p1']);
  });

  it('compares exact bookings by instant', () => {
    const want = { patient: 'p1', provider: 'dr_karim', start: '2026-11-10T10:00' };
    const final_calendar = { exact: [want] };
    assert.deepEqual(failed(check({ final_calendar }, { calendar: [booking()] })), []);
    assert.deepEqual(failed(check({ final_calendar }, { calendar: [booking({ start: '2026-11-10T05:00:00.000Z' })] })), ['calendar.exact']);
    assert.deepEqual(failed(check({ final_calendar }, { calendar: [booking({ providerId: 'dr_nasrin' })] })), ['calendar.exact']);
    assert.deepEqual(failed(check({ final_calendar }, { calendar: [booking({ patientId: 'p2' })] })), ['calendar.exact']);
  });

  it('fails exact when there is an extra booking', () => {
    const final_calendar = { exact: [{ patient: 'p1', provider: 'dr_karim', start: '2026-11-10T10:00' }] };
    const calendar = [booking(), booking({ start: '2026-11-10T05:00:00.000Z' })];
    assert.deepEqual(failed(check({ final_calendar }, { calendar })), ['calendar.exact']);
  });

  it('checks every reply for banned phrases, ignoring case and numeral script', () => {
    const turns = [
      { reply: 'Your appointment IS CONFIRMED.', guards: [] },
      { reply: 'সকাল ৯টায় খালি আছে', guards: [] },
    ];
    assert.deepEqual(failed(check({ must_not_say: ['is confirmed'] }, { turns })), ['must_not_say: is confirmed']);
    assert.deepEqual(failed(check({ must_not_say: ['সকাল 9টায়'] }, { turns })), ['must_not_say: সকাল 9টায়']);
    assert.deepEqual(failed(check({ must_not_say: ['cancelled'] }, { turns })), []);
  });

  it('checks the language of the final reply', () => {
    const turns = [{ reply: 'ঠিক আছে', guards: [] }];
    assert.deepEqual(failed(check({ reply_language: 'bn' }, { turns })), []);
    assert.deepEqual(failed(check({ reply_language: 'en' }, { turns })), ['reply_language']);
  });

  it('checks a tool sequence in order, allowing others in between', () => {
    const toolCalls = ['find_patient', 'check_availability', 'create_booking'].map((tool) => ({ tool }));
    assert.deepEqual(failed(check({ tool_sequence_includes: ['find_patient', 'create_booking'] }, { toolCalls })), []);
    assert.deepEqual(failed(check({ tool_sequence_includes: ['create_booking', 'find_patient'] }, { toolCalls })), ['tool_sequence_includes']);
  });

  it('only counts a guard as fired if it actually failed', () => {
    const turns = [{ reply: 'x', guards: [{ guard: 'identity_gate', ok: true }, { guard: 'booking_verify', ok: false }] }];
    assert.deepEqual(failed(check({ guards_fired: ['identity_gate'] }, { turns })), ['guard_fired: identity_gate']);
    assert.deepEqual(failed(check({ guards_fired: ['booking_verify'] }, { turns })), []);
    assert.deepEqual(failed(check({ guards_not_fired: ['booking_verify'] }, { turns })), ['guard_not_fired: booking_verify']);
  });

  it('accepts any of several handoff reasons', () => {
    const handoffs = [{ reason: 'angry_user' }];
    assert.deepEqual(failed(check({ handoff_reason: ['angry_user', 'other'] }, { handoffs })), []);
    assert.deepEqual(failed(check({ handoff_reason: 'tool_error' }, { handoffs })), ['handoff_reason']);
  });

  it('offer_alternative_or_handoff needs a time that is really free', () => {
    const freeSlots = [{ start: '2026-11-10T04:30:00.000Z' }];
    const reply = (text) => ({ turns: [{ reply: text, guards: [] }], freeSlots });
    const must = { must: 'offer_alternative_or_handoff' };
    assert.deepEqual(failed(check(must, reply('10:30 AM is free. Would that work?'))), []);
    assert.deepEqual(failed(check(must, reply('11:30 AM is free.'))), ['must: offer_alternative_or_handoff']);
    assert.deepEqual(failed(check(must, reply('Sorry about that.'))), ['must: offer_alternative_or_handoff']);
    assert.deepEqual(failed(check(must, { ...reply('Sorry.'), conversations: [{ status: 'handed_off' }] })), []);
  });

  it('applies offline expectations to scripted runs only', () => {
    const scenario = minimalScenario({
      expect: { audit_excludes: ['a'] },
      offline_expect: { audit_excludes: ['b'], guards_fired: ['identity_gate'] },
    });
    assert.deepEqual(effectiveExpect(scenario, 'scripted').audit_excludes, ['a', 'b']);
    assert.deepEqual(effectiveExpect(scenario, 'scripted').guards_fired, ['identity_gate']);
    assert.equal(effectiveExpect(scenario, 'claude').guards_fired, undefined);
  });

  it('checks scripts were used as authored, in scripted mode only', () => {
    const scenario = minimalScenario();
    const scripted = (run) => failed(evaluateChecks({ scenario, mode: 'scripted', run: minimalRun(run), tz: TZ }));
    assert.deepEqual(scripted({ scriptRemaining: 1 }), ['script_fully_used']);
    assert.deepEqual(scripted({ scriptExhausted: true }), ['script_not_exhausted']);
    assert.deepEqual(failed(evaluateChecks({ scenario, mode: 'claude', run: minimalRun({ scriptRemaining: 1 }), tz: TZ })), []);
  });

  it('labels each check as an outcome or a mechanic', () => {
    const kinds = Object.fromEntries(
      check(
        { final_calendar: { total_active: 0 }, must_not_say: ['x'], conversation_status: 'active', guards_fired: ['identity_gate'] },
      ).map((c) => [c.name, c.kind]),
    );
    assert.equal(kinds['calendar.total_active'], 'state');
    assert.equal(kinds['must_not_say: x'], 'text');
    assert.equal(kinds.conversation_status, 'status');
    assert.equal(kinds['guard_fired: identity_gate'], 'guard');
  });
});

describe('running a scenario', () => {
  let prisma;
  before(async () => {
    await migrateTestDatabase();
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  const scenario = minimalScenario({
    seed: {
      patients: [{ id: 'p1', name: 'Rahim Uddin', phone: '+8801711000001', dob: '1985-03-12' }],
      slots: [{ provider: 'dr_karim', start: '2026-11-10T10:00' }],
      bookings: [],
    },
    now: '2026-11-04T10:00',
    channel: 'web',
    allow_unused_script: false,
    turns: [{ user: 'Hello', script: [{ say: 'From the script.' }] }],
    expect: { final_calendar: { total_active: 0 } },
    offline_expect: { guards_fired: ['identity_gate'] },
  });

  const reply = (text) => ({
    content: [{ type: 'text', text }],
    text,
    toolUses: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 },
    model: 'claude-opus-5-5',
  });

  it('ignores the script and offline expectations with a real model', async () => {
    const client = { complete: async () => reply('From the model.') };
    const run = await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    assert.equal(run.turns[0].reply, 'From the model.');
    assert.equal(run.pass, true);
  });

  it('applies offline expectations to a scripted run', async () => {
    const run = await runScenario(scenario, { prisma, mode: 'scripted', tz: TZ });
    assert.equal(run.turns[0].reply, 'From the script.');
    assert.deepEqual(failed(run.checks), ['guard_fired: identity_gate']);
    assert.equal(run.pass, false);
  });

  it('estimates cost from token usage', async () => {
    const client = { complete: async () => reply('Hello.') };
    const run = await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    // 1000 input at $4/M, 100 output at $20/M, 500 cache reads at $0.20/M.
    assert.ok(Math.abs(run.costUsd - 0.0061) < 1e-9, String(run.costUsd));
    assert.equal(run.llmCalls, 1);
  });

  it('flags a credentials failure rather than scoring it as a handoff', async () => {
    const client = {
      complete: async () => {
        throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
      },
    };
    const run = await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    assert.equal(run.fatal.status, 401);
  });

  it('does not treat an overload as fatal', async () => {
    const client = {
      complete: async () => {
        throw Object.assign(new Error('overloaded'), { status: 529 });
      },
    };
    const run = await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    assert.equal(run.fatal, null);
    assert.equal(run.handoffs[0].reason, 'llm_error');
  });

  it('starts each scenario from a clean database', async () => {
    const client = { complete: async () => reply('Hello.') };
    await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    await runScenario(scenario, { prisma, mode: 'claude', client, tz: TZ });
    assert.equal(await prisma.patient.count(), 1);
    assert.equal(await prisma.conversation.count(), 1);
  });
});

describe('regressions', () => {
  const summary = (mode, results) => ({ mode, results });
  const result = (id, pass) => ({ id, pass });

  it('lists scenarios that passed before and fail now', () => {
    const before = summary('claude', [result('a', true), result('b', true), result('c', false)]);
    const now = summary('claude', [result('a', true), result('b', false), result('c', false), result('d', false)]);
    assert.deepEqual(findRegressions(now, before), ['b']);
  });

  it('has nothing to compare without a baseline in the same mode', () => {
    const now = summary('claude', [result('a', false)]);
    assert.equal(findRegressions(now, null), null);
    assert.equal(findRegressions(now, summary('scripted', [result('a', true)])), null);
  });
});
