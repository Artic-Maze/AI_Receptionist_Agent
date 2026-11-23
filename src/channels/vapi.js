import { randomUUID, timingSafeEqual } from 'node:crypto';

import { guardDisabled, saveConversation, withLock } from '../agent/state.js';
import { findOrStartConversation, recordHandoff, runTurn } from '../agent/turn.js';
import { auditCreate } from '../audit/log.js';
import { config } from '../config.js';
import { handoffReply } from '../guards/handoff-triggers.js';
import { executeTool } from '../tools/execute.js';
import { normalizePhone } from '../tools/identity.js';
import { TOOLS } from '../tools/index.js';

/**
 * Two ways to connect a Vapi assistant. The recommended one makes this server the
 * assistant's model (POST /vapi/llm/chat/completions): Vapi sends what the caller
 * said, and speaks exactly the reply that passed the guards.
 *
 * The other gives Vapi's own model one tool that hands over each thing the caller
 * says and returns the reply to speak. Every guard runs on that reply, but Vapi's
 * model is still the one speaking and could word it differently. The individual tools
 * are also exposed, with their pre-tool guards and read-back verification, but if
 * Vapi's model calls them directly, nothing checks what it then says out loud.
 */
export const TURN_TOOL = 'receptionist_turn';

/**
 * Either header may carry the secret. Vapi's custom-LLM requests always send an
 * Authorization header of their own, so a bearer that doesn't match must not rule
 * out an X-Vapi-Secret that does.
 */
function authorized(headers, secret) {
  if (!secret) return false;
  const expected = Buffer.from(secret);
  const matches = (value) => {
    if (typeof value !== 'string') return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
  return matches(bearer) || matches(headers['x-vapi-secret']);
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
      return { error: handoffReply('holding', conversation) };
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
      say = handoffReply(turn.forcedHandoff.reason, conversation);
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

// ---- Custom LLM: this server is the assistant's model ----------------------

/** Spoken when a turn fails outright. It claims nothing, so it needs no guard. */
const FAILED = {
  en: 'Sorry, something went wrong on our side. Please try again in a moment.',
  es: 'Lo siento, algo ha fallado por nuestra parte. Inténtelo de nuevo en un momento.',
  bn: 'দুঃখিত, আমাদের দিক থেকে একটি সমস্যা হয়েছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।',
};

/** OpenAI message content: a string, or an array of parts. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ');
  return '';
}

/**
 * What the caller has said since the assistant last spoke. Vapi sends the whole call
 * every time, but the agent's history, tool results included, is in the database, so
 * only the new words are needed.
 */
export function newCallerText(messages) {
  if (!Array.isArray(messages)) return '';
  const lastSpoken = messages.findLastIndex((m) => m?.role === 'assistant');
  return messages
    .slice(lastSpoken + 1)
    .filter((m) => m?.role === 'user')
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join(' ');
}

/** The reply to speak, from a full agent turn. */
async function completionText(deps, body, log) {
  // Sent while the assistant's metadataSendMode is "variable" (Vapi's default) or "destructured".
  if (!body.call?.id) {
    log.warn({ keys: Object.keys(body) }, 'vapi completion has no call id; check the assistant sends call metadata');
    return FAILED.en;
  }
  let conversation;
  try {
    conversation = await conversationFor(deps, body);
    const text = newCallerText(body.messages);
    if (!text) return '';
    const turn = await runTurn(deps, { conversationId: conversation.id, text });
    return turn.reply ?? '';
  } catch (error) {
    log.error({ err: error, callId: body.call.id }, 'vapi completion failed');
    return FAILED[conversation?.language] ?? FAILED.en;
  }
}

/**
 * OpenAI's chat completions format, which is what Vapi speaks to a custom LLM. The
 * reply goes out in one chunk once the guards have passed it, as on every channel:
 * streaming word by word would let unchecked words reach the caller.
 */
async function handleCompletion(deps, request, reply) {
  const body = request.body ?? {};
  const text = await completionText(deps, body, request.log);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : 'receptionist';

  if (body.stream === false) {
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    };
  }

  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  reply.hijack();
  // The caller may have hung up or talked over the reply, and Vapi dropped the request.
  if (reply.raw.destroyed) return reply;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.end(`${chunk({ role: 'assistant', content: text })}${chunk({}, 'stop')}data: [DONE]\n\n`);
  return reply;
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

  // The assistant's model url is a base URL: Vapi's OpenAI client adds /chat/completions.
  app.post('/vapi/llm/chat/completions', async (request, reply) => {
    if (!authorized(request.headers, secret)) return reply.code(401).send({ error: 'unauthorized' });
    return handleCompletion(deps, request, reply);
  });
}
