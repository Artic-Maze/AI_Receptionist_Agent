import { createHmac, timingSafeEqual } from 'node:crypto';

import { findOrStartConversation, runTurn } from '../agent/turn.js';
import { normalizePhone } from '../tools/identity.js';

const TEXT_ONLY = {
  en: 'I can only read text messages at the moment. Please type your request.',
  bn: 'আমি এই মুহূর্তে শুধু লেখা বার্তা পড়তে পারি। অনুগ্রহ করে আপনার অনুরোধটি লিখে পাঠান।',
};

export function validSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Replies only ever answer an inbound message, so they are always inside the 24-hour window. */
async function sendText({ whatsapp, fetchImpl }, to, body) {
  const url = `https://graph.facebook.com/${whatsapp.apiVersion}/${whatsapp.phoneNumberId}/messages`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } }),
  });
  if (!response.ok) throw new Error(`WhatsApp send failed with ${response.status}: ${await response.text()}`);
}

async function handleMessage(deps, options, message) {
  const { from } = message;
  const conversation = await findOrStartConversation(deps.prisma, {
    channel: 'whatsapp',
    externalId: from,
    callerPhone: normalizePhone(`+${from}`),
  });
  if (message.type !== 'text' || !message.text?.body) {
    await sendText(options, from, TEXT_ONLY[conversation.language] ?? TEXT_ONLY.en);
    return;
  }
  const result = await runTurn(deps, {
    conversationId: conversation.id,
    text: message.text.body,
    externalId: message.id,
  });
  // Meta retries webhooks, and a retry must not send a second reply.
  if (!result.duplicate) await sendText(options, from, result.reply);
}

function inboundMessages(payload) {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.messages ?? []);
}

/**
 * @param {object} options
 * @param {object} options.whatsapp  verifyToken, appSecret, accessToken, phoneNumberId, apiVersion
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.awaitProcessing]  for tests. Meta needs a fast 200, so production
 *   acknowledges first and works afterwards.
 */
export function registerWhatsappChannel(app, deps, { whatsapp, fetchImpl = globalThis.fetch, awaitProcessing = false }) {
  const options = { whatsapp, fetchImpl };

  // Scoped, so only this route keeps the raw body the signature is computed over.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.get('/whatsapp', async (request, reply) => {
      const query = request.query;
      const matches =
        whatsapp.verifyToken &&
        query['hub.mode'] === 'subscribe' &&
        query['hub.verify_token'] === whatsapp.verifyToken;
      if (!matches) return reply.code(403).send();
      reply.type('text/plain');
      return String(query['hub.challenge'] ?? '');
    });

    scope.post('/whatsapp', async (request, reply) => {
      if (!validSignature(request.body, request.headers['x-hub-signature-256'], whatsapp.appSecret)) {
        return reply.code(403).send();
      }
      let payload;
      try {
        payload = JSON.parse(request.body.toString('utf8'));
      } catch {
        return reply.code(400).send();
      }
      const work = Promise.all(
        inboundMessages(payload).map((message) =>
          handleMessage(deps, options, message).catch((error) => {
            request.log.error({ err: error, messageId: message.id }, 'whatsapp message failed');
          }),
        ),
      );
      if (awaitProcessing) await work;
      return reply.code(200).send();
    });
  });
}
