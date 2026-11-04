import { auditCreate } from '../audit/log.js';
import { config } from '../config.js';
import { checkAvailabilityGrounding, loadGrounding } from '../guards/availability-grounding.js';
import { checkConfirmation } from '../guards/confirmation-check.js';
import {
  checkPatientMessage,
  handoffMessage,
  isMisunderstanding,
  MAX_MISUNDERSTANDINGS,
} from '../guards/handoff-triggers.js';
import { executeTool } from '../tools/execute.js';
import { LLM_TOOLS } from '../tools/index.js';
import { buildCorrectionNote, buildSystemPrompt, buildTurnNote } from './prompt.js';
import { detectLanguage, guardDisabled, saveConversation, withLock } from './state.js';

export const MAX_TOOL_CALLS_PER_TURN = 6;

/**
 * @typedef {object} Deps
 * @property {import('@prisma/client').PrismaClient} prisma
 * @property {import('./llm.js').LLMClient} llm
 * @property {import('../calendar/adapter.js').CalendarAdapter} calendar
 * @property {() => Date} [clock]
 * @property {string} [tz]
 * @property {string} [clinicName]
 * @property {Set<string>} [disabledGuards]  only the regression suite sets this
 */

/**
 * Starts a new conversation. `callerPhone` is the channel's identity hint: the WhatsApp
 * sender or the voice caller ID.
 */
export function startConversation(prisma, { channel, externalId, language = 'en', callerPhone }) {
  return prisma.conversation.create({
    data: { channel, externalId, language, state: callerPhone ? { callerPhone } : {} },
  });
}

/** The open conversation for a WhatsApp sender or voice call, or a new one. */
export function findOrStartConversation(prisma, { channel, externalId, language, callerPhone }) {
  return withLock(`start:${channel}:${externalId}`, async () => {
    const existing = await prisma.conversation.findFirst({
      where: { channel, externalId, status: { not: 'closed' } },
      orderBy: { createdAt: 'desc' },
    });
    return existing ?? startConversation(prisma, { channel, externalId, language, callerPhone });
  });
}

/** Marks the conversation as staff's. Callers decide what the patient is told. */
export async function recordHandoff(prisma, conversation, { reason, detail }) {
  await prisma.handoff.create({ data: { conversationId: conversation.id, reason, detail } });
  conversation.status = 'handed_off';
  await auditCreate(prisma, {
    conversationId: conversation.id,
    action: 'handoff.created',
    patientId: conversation.patientId,
    after: { reason, detail },
  });
}

async function loadHistory(prisma, conversationId) {
  const rows = await prisma.message.findMany({
    where: { conversationId, kind: { in: ['chat', 'llm'] } },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ role, content }) => ({ role, content }));
}

/**
 * The tool loop and reply guards. Returns the approved reply, or null when the
 * conversation should go to a person (turn.forcedHandoff says why).
 */
async function runModel(ctx, push, history, onEvent) {
  const { deps, conversation, turn, tz, now } = ctx;
  const { prisma, llm, calendar } = deps;
  const system = buildSystemPrompt({ clinicName: deps.clinicName ?? config.clinicName });
  let toolCalls = 0;
  let regenerated = false;

  for (;;) {
    let response;
    try {
      response = await llm.complete({ system, tools: LLM_TOOLS, messages: history });
    } catch (error) {
      turn.forcedHandoff = { reason: 'llm_error', detail: error.message };
      return null;
    }

    if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') {
      turn.forcedHandoff = { reason: `llm_${response.stopReason}` };
      return null;
    }

    if (response.toolUses.length > 0) {
      await push('assistant', 'llm', response.content);
      const results = [];
      for (const use of response.toolUses) {
        toolCalls += 1;
        let result;
        if (turn.forcedHandoff) {
          result = { output: { error: 'skipped', message: 'The conversation is being handed off.' }, isError: true };
        } else if (toolCalls > MAX_TOOL_CALLS_PER_TURN) {
          turn.forcedHandoff = { reason: 'tool_limit', detail: `More than ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn.` };
          result = { output: { error: 'tool_limit', message: 'Too many tool calls in this turn.' }, isError: true };
        } else {
          turn.tools.push(use.name);
          onEvent({ type: 'tool', name: use.name });
          result = await executeTool(ctx, use.name, use.input);
        }
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result.output),
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      await push('user', 'llm', results);
      if (turn.forcedHandoff) return null;
      continue;
    }

    // ---- A reply: nothing reaches the patient until it passes these guards ----
    const reply = response.text;
    const checks = [];
    if (!reply) {
      checks.push({ guard: 'reply_present', ok: false, reason: 'The reply was empty.' });
    } else {
      const providers = await calendar.listProviders();
      const grounding = await loadGrounding(prisma, conversation.id);
      checks.push(
        guardDisabled(ctx, 'availability_grounding')
          ? { guard: 'availability_grounding', ok: true, disabled: true }
          : checkAvailabilityGrounding({ reply, grounding, patientTexts: ctx.patientTexts, providers, now, tz }),
        guardDisabled(ctx, 'confirmation_check')
          ? { guard: 'confirmation_check', ok: true, disabled: true }
          : checkConfirmation({
              reply,
              verified: turn.verified,
              activeBookings: grounding.activeBookings,
              providers,
              now,
              tz,
            }),
      );
    }
    turn.guardResults.push(...checks);
    const failures = checks.filter((check) => !check.ok);

    if (failures.length === 0) {
      const state = conversation.state;
      const confused = turn.tools.length === 0 && isMisunderstanding(reply);
      state.misunderstandings = confused ? (state.misunderstandings ?? 0) + 1 : 0;
      if (state.misunderstandings >= MAX_MISUNDERSTANDINGS && !guardDisabled(ctx, 'handoff_triggers')) {
        await push('assistant', 'llm', response.content);
        turn.forcedHandoff = { reason: 'misunderstanding', detail: `${state.misunderstandings} turns without understanding.` };
        return null;
      }
      await push('assistant', 'chat', response.content);
      return reply;
    }

    if (response.content.length) await push('assistant', 'llm', response.content);
    if (regenerated) {
      turn.forcedHandoff = {
        reason: 'guard_failure',
        detail: failures.map((f) => f.guard).join(', '),
      };
      return null;
    }

    // One regeneration. The system note carries the correction with clinic authority;
    // it must follow a user message, hence the neutral marker before it.
    regenerated = true;
    await push('user', 'llm', '(Automated marker: no new message from the patient.)');
    await push('system', 'llm', buildCorrectionNote(failures));
  }
}

async function runLocked(deps, { conversationId, text, externalId, onEvent = () => {} }) {
  const { prisma, calendar } = deps;
  const clock = deps.clock ?? (() => new Date());
  const tz = deps.tz ?? config.tz;

  if (externalId) {
    // Webhook retries must not run a second turn, and could otherwise double-book.
    const seen = await prisma.message.findUnique({ where: { externalId } });
    if (seen) return { duplicate: true, conversationId, reply: null };
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  conversation.state ??= {};
  conversation.language = detectLanguage(text, conversation.language);
  const { language } = conversation;
  const now = clock();

  const history = await loadHistory(prisma, conversationId);
  const push = async (role, kind, content, messageExternalId) => {
    await prisma.message.create({
      data: { conversationId, role, kind, content, externalId: messageExternalId },
    });
    if (kind !== 'display') history.push({ role, content });
  };

  // Once staff have it, the agent stays out of the conversation.
  if (conversation.status !== 'active') {
    await push('user', 'display', text, externalId);
    const reply = handoffMessage('holding', language);
    await push('assistant', 'display', reply);
    await saveConversation(prisma, conversation);
    return {
      conversationId,
      reply,
      status: conversation.status,
      handedOff: conversation.status === 'handed_off',
      guardResults: [],
    };
  }

  const turn = { guardResults: [], verified: [], tools: [], forcedHandoff: null };
  const patientTexts = await prisma.message
    .findMany({ where: { conversationId, role: 'user', kind: 'chat' }, orderBy: { id: 'asc' } })
    .then((rows) => [...rows.map((row) => row.content), text]);
  const ctx = { deps, conversation, turn, tz, now, patientTexts };

  await push('user', 'chat', text, externalId);

  if (!guardDisabled(ctx, 'handoff_triggers')) {
    const trigger = checkPatientMessage(text);
    turn.guardResults.push(trigger);
    if (!trigger.ok) turn.forcedHandoff = { reason: trigger.trigger, source: 'patient_message' };
  }

  let reply = null;
  if (!turn.forcedHandoff) {
    const providers = await calendar.listProviders();
    const patient = conversation.patientId
      ? await prisma.patient.findUnique({ where: { id: conversation.patientId } })
      : null;
    await push(
      'system',
      'llm',
      buildTurnNote({
        now,
        tz,
        language,
        channel: conversation.channel,
        patient,
        providers,
        callerPhone: conversation.state.callerPhone,
      }),
    );
    reply = await runModel(ctx, push, history, onEvent);
  }

  // ---- Handoff: the reply is written here, never by the model ----------------
  const handoff = turn.forcedHandoff;
  if (handoff) {
    if (handoff.source !== 'patient_message') {
      turn.guardResults.push({ guard: 'handoff_triggers', ok: false, trigger: handoff.reason, source: handoff.source ?? 'system' });
    }
    await recordHandoff(prisma, conversation, handoff);
    reply = handoffMessage(handoff.reason, language);
    await push('assistant', 'display', reply);
  }

  await saveConversation(prisma, conversation);

  // The audit entry is written before the channel sends anything.
  await auditCreate(prisma, {
    conversationId,
    action: 'turn.completed',
    patientId: conversation.patientId,
    after: {
      handed_off: Boolean(handoff),
      handoff_reason: handoff?.reason,
      tools: turn.tools,
      verified: turn.verified.map((v) => ({ action: v.action, booking: v.booking.id })),
    },
    guardResults: turn.guardResults,
  });

  return {
    conversationId,
    reply,
    status: conversation.status,
    handedOff: Boolean(handoff),
    handoffReason: handoff?.reason,
    guardResults: turn.guardResults,
  };
}

/**
 * One patient message, start to finish. Every channel calls this; only the transport
 * differs. Replies are not streamed, because no text may reach the patient until the
 * reply guards have passed the whole of it.
 *
 * @param {Deps} deps
 * @param {{ conversationId: string, text: string, externalId?: string,
 *           onEvent?: (event: { type: string, name: string }) => void }} input
 */
export function runTurn(deps, input) {
  return withLock(input.conversationId, () => runLocked(deps, input));
}
