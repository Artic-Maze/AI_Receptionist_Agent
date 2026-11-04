import { runTurn, startConversation } from '../../src/agent/turn.js';
import { FakeAdapter } from '../../src/calendar/fake.js';
import { parseLocal } from '../../src/time.js';
import { evaluateChecks } from './checks.js';
import { resetDatabase } from './db.js';
import { ScriptedLLM } from './scripted-llm.js';

export const EVAL_PROVIDERS = [
  { id: 'dr_karim', name: 'Dr. Karim', nameBn: 'ডা. করিম', specialty: 'General Medicine' },
  { id: 'dr_nasrin', name: 'Dr. Nasrin', nameBn: 'ডা. নাসরিন', specialty: 'Cardiology' },
];

// USD per million tokens. A report estimate, not billing.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

function estimateCost(calls) {
  let total = 0;
  for (const { model, usage } of calls) {
    const price = PRICES[model];
    if (!price) continue;
    total +=
      (usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheWriteTokens * price.cacheWrite) /
      1e6;
  }
  return total;
}

/** Records usage, and stops the suite on errors that retrying cannot fix. */
class MeteredLLM {
  calls = [];
  fatal = null;
  #inner;

  constructor(inner) {
    this.#inner = inner;
  }

  async complete(request) {
    try {
      const response = await this.#inner.complete(request);
      this.calls.push({ model: response.model, usage: response.usage });
      return response;
    } catch (error) {
      // These mean bad credentials or a malformed request. Left alone, every scenario
      // would quietly end as a handoff, which looks like the guards working.
      if ([400, 401, 403, 404].includes(error.status)) this.fatal = error;
      throw error;
    }
  }
}

function buildCalendar(scenario, clock, tz) {
  const calendar = new FakeAdapter({ clock });
  calendar.seed({
    providers: EVAL_PROVIDERS,
    slots: scenario.seed.slots.map((s) => ({ providerId: s.provider, start: parseLocal(s.start, tz) })),
    bookings: scenario.seed.bookings.map((b) => ({
      id: b.id,
      patientId: b.patient,
      providerId: b.provider,
      start: parseLocal(b.start, tz),
    })),
  });
  calendar.setInjections(
    scenario.inject.map((injection) => ({
      ...injection,
      ...(injection.slot
        ? { slot: { providerId: injection.slot.provider, start: parseLocal(injection.slot.start, tz) } }
        : {}),
    })),
  );
  return calendar;
}

/**
 * Reset, seed, replay, check. Scenarios go through the real agent loop, real guards
 * and real Postgres; only the calendar, and in scripted mode the model, are stand-ins.
 *
 * @param {object} scenario
 * @param {object} options
 * @param {'scripted'|'claude'} options.mode
 * @param {import('../../src/agent/llm.js').LLMClient} [options.client]  for claude mode
 * @param {Set<string>} [options.disabledGuards]  for the mutation test
 */
export async function runScenario(scenario, { prisma, mode, client, disabledGuards, tz }) {
  const started = performance.now();
  await resetDatabase(prisma);
  for (const patient of scenario.seed.patients) await prisma.patient.create({ data: patient });

  const now = parseLocal(scenario.now, tz);
  const clock = () => now;
  const calendar = buildCalendar(scenario, clock, tz);
  const scripted = mode === 'scripted' ? new ScriptedLLM() : null;
  const metered = new MeteredLLM(scripted ?? client);
  const deps = { prisma, llm: metered, calendar, clock, tz, clinicName: 'Artic Maze Clinic', disabledGuards };

  const conversationIds = new Map();
  const turns = [];
  let crash = null;

  for (const turn of scenario.turns) {
    const key = turn.conversation ?? 'main';
    if (!conversationIds.has(key)) {
      const { id } = await startConversation(prisma, {
        channel: scenario.channel,
        language: scenario.language,
        callerPhone: scenario.caller_phone,
      });
      conversationIds.set(key, id);
    }
    scripted?.load(turn.script);
    try {
      const result = await runTurn(deps, { conversationId: conversationIds.get(key), text: turn.user });
      turns.push({
        user: turn.user,
        conversation: key,
        reply: result.reply,
        handedOff: result.handedOff,
        handoffReason: result.handoffReason,
        guards: result.guardResults,
      });
    } catch (error) {
      crash = error.stack ?? String(error);
      turns.push({ user: turn.user, conversation: key, reply: null, guards: [] });
      break;
    }
    if (metered.fatal) break;
  }

  const [toolCalls, audit, handoffs, conversations] = await Promise.all([
    prisma.toolCall.findMany({ orderBy: { id: 'asc' } }),
    prisma.auditLog.findMany({ orderBy: { id: 'asc' } }),
    prisma.handoff.findMany({ orderBy: { id: 'asc' } }),
    prisma.conversation.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);

  const run = {
    crash,
    turns,
    toolCalls: toolCalls.map(({ tool, input, output, error, durationMs }) => ({ tool, input, output, error, durationMs })),
    audit: audit.map(({ action, patientId, bookingId, before, after, guardResults }) => ({
      action,
      patientId,
      bookingId,
      before,
      after,
      guardResults,
    })),
    handoffs: handoffs.map(({ reason, detail }) => ({ reason, detail })),
    conversations: conversations.map(({ status, patientId, language }) => ({ status, patientId, language })),
    calendar: calendar.snapshot(),
    freeSlots: calendar.freeSlots(),
    scriptRemaining: scripted?.remaining ?? 0,
    scriptExhausted: scripted?.exhausted ?? false,
    latencyMs: Math.round(performance.now() - started),
    llmCalls: metered.calls.length,
    costUsd: estimateCost(metered.calls),
    usage: metered.calls.reduce(
      (sum, { usage }) => ({
        inputTokens: sum.inputTokens + usage.inputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ),
  };

  const checks = evaluateChecks({ scenario, mode, run, tz });
  return { ...run, checks, pass: checks.every((check) => check.pass), fatal: metered.fatal };
}
