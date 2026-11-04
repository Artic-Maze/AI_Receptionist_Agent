import { timingSafeEqual } from 'node:crypto';

import { guardDisabled, saveConversation, withLock } from '../agent/state.js';
import { findOrStartConversation, recordHandoff, runTurn } from '../agent/turn.js';
import { auditCreate } from '../audit/log.js';
import { config } from '../config.js';
import { handoffMessage } from '../guards/handoff-triggers.js';
import { executeTool } from '../tools/execute.js';
import { normalizePhone } from '../tools/identity.js';
import { TOOLS } from '../tools/index.js';

/**
 * The recommended voice setup: one Vapi tool that hands over each thing the caller
 * says and speaks back the result. It runs the whole agent turn, so every guard
 * applies. The individual tools below keep their pre-tool guards and read-back
 * verification, but if Vapi's model calls them directly, nothing checks what it then
 * says out loud.
 */
export const TURN_TOOL = 'receptionist_turn';

function authorized(headers, secret) {
  if (!secret) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
  const given = Buffer.from(bearer ?? headers['x-vapi-secret'] ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Vapi needs results as a single line of text: no objects, arrays or line breaks. */
const flat = (text) => String(text).replace(/\s*\n\s*/g, ' ').trim();

function parseToolCall(call) {
  const name = call.function?.name ?? call.name;
  const raw = call.function?.arguments ?? call.arguments ?? {};
  return { id: call.id, name, args: typeof raw === 'string' ? JSON.parse(raw) : raw };
}

async function conversationFor(deps, message) {
  const callId = message.call?.id;
  if (!callId) throw new Error('The message has no call id');
  const number = message.call?.customer?.number ?? message.customer?.number;
  return findOrStartConversation(deps.prisma, {
    channel: 'vapi',
    externalId: callId,
    callerPhone: number ? normalizePhone(number) : undefined,
  });
}

/** One tool run outside a full turn: same executor, same guards, same logging. */
function runDirectTool(deps, conversationId, name, args) {
  return withLock(conversationId, async () => {
    const { prisma } = deps;
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    conversation.state ??= {};
    if (conversation.status !== 'active') {
      return { error: handoffMessage('holding', conversation.language) };
    }
    const turn = { guardResults: [], verified: [], tools: [name], forcedHandoff: null };
    const ctx = {
      deps,
      conversation,
      turn,
      tz: deps.tz ?? config.tz,
      now: (deps.clock ?? (() => new Date()))(),
      patientTexts: [],
    };
    const { output, isError } = await executeTool(ctx, name, args);
    let say;
    if (turn.forcedHandoff && !guardDisabled(ctx, 'handoff_triggers')) {
      await recordHandoff(prisma, conversation, turn.forcedHandoff);
      say = handoffMessage(turn.forcedHandoff.reason, conversation.language);
    }
    await saveConversation(prisma, conversation);
    await auditCreate(prisma, {
      conversationId,
      action: 'voice_tool.completed',
      patientId: conversation.patientId,
      after: { tool: name, handoff_reason: turn.forcedHandoff?.reason },
      guardResults: turn.guardResults,
    });
    if (say) return { result: flat(JSON.stringify({ ...output, handed_off: true, say })) };
    return isError ? { error: flat(JSON.stringify(output)) } : { result: flat(JSON.stringify(output)) };
  });
}

async function handleToolCalls(deps, message, log) {
  const conversation = await conversationFor(deps, message);
  const results = [];
  // In order, so a booking made in this message can be read back by the next call in it.
  for (const raw of message.toolCallList ?? []) {
    const base = { toolCallId: raw.id };
    try {
      const { name, args } = parseToolCall(raw);
      base.name = name;
      if (name === TURN_TOOL) {
        const text = String(args.utterance ?? args.message ?? '').trim();
        if (!text) {
          results.push({ ...base, error: 'The utterance was empty.' });
          continue;
        }
        const turn = await runTurn(deps, { conversationId: conversation.id, text });
        results.push({ ...base, result: flat(turn.reply) });
      } else if (TOOLS[name]) {
        results.push({ ...base, ...(await runDirectTool(deps, conversation.id, name, args)) });
      } else {
        results.push({ ...base, error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      log.error({ err: error, toolCallId: raw.id }, 'vapi tool call failed');
      results.push({ ...base, error: 'The tool failed. Please tell the caller a member of staff will help.' });
    }
  }
  return { results };
}

const TRANSCRIPT_ROLES = { user: 'user', assistant: 'assistant', bot: 'assistant' };

async function storeTranscript(deps, message) {
  const { prisma } = deps;
  const conversation = await conversationFor(deps, message);
  const entries = message.artifact?.messages ?? [];
  const rows = entries.flatMap((entry, index) => {
    const role = TRANSCRIPT_ROLES[entry.role];
    if (!role || !entry.message) return [];
    return [
      {
        conversationId: conversation.id,
        role,
        kind: 'display',
        content: entry.message,
        externalId: `vapi:${message.call.id}:${index}`,
      },
    ];
  });
  // Skips rows already stored, so a retried report changes nothing.
  await prisma.message.createMany({ data: rows, skipDuplicates: true });
  await auditCreate(prisma, {
    conversationId: conversation.id,
    action: 'call.ended',
    patientId: conversation.patientId,
    after: { ended_reason: message.endedReason, transcript_messages: rows.length },
  });
  return {};
}

/**
 * Always answers 200 once authorized, as Vapi ignores other statuses and tells the
 * caller "no result returned". Failures go in each result's `error` field.
 */
export function registerVapiChannel(app, deps, { secret }) {
  const handler = async (request, reply) => {
    if (!authorized(request.headers, secret)) return reply.code(401).send({ error: 'unauthorized' });
    const message = request.body?.message;
    try {
      if (message?.type === 'tool-calls') return await handleToolCalls(deps, message, request.log);
      if (message?.type === 'end-of-call-report') return await storeTranscript(deps, message);
    } catch (error) {
      request.log.error({ err: error, type: message?.type }, 'vapi event failed');
      if (message?.type === 'tool-calls') {
        return {
          results: (message.toolCallList ?? []).map((raw) => ({
            toolCallId: raw.id,
            error: 'The tool failed. Please tell the caller a member of staff will help.',
          })),
        };
      }
    }
    return {};
  };
  app.post('/vapi/tools/:tool', handler);
  app.post('/vapi/events', handler);
}
