import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { TURN_TOOL } from '../src/channels/vapi.js';
import { buildServer } from '../src/server.js';
import { createTestPrisma, migrateTestDatabase } from '../evals/lib/db.js';
import { at, RAHIM, setup } from './helpers/harness.js';

const IDENTIFY = { call: 'find_patient', input: { name: 'Rahim Uddin', dob: '1985-03-12' } };

describe('channels', () => {
  let prisma;
  before(async () => {
    await migrateTestDatabase();
    prisma = createTestPrisma();
  });
  after(() => prisma.$disconnect());

  describe('web', () => {
    async function chat(app, body) {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      try {
        const response = await fetch(`${address}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) return { status: response.status, events: [] };
        const text = await response.text();
        const events = text
          .trim()
          .split('\n\n')
          .map((block) => ({
            event: /^event: (.+)$/m.exec(block)[1],
            data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
          }));
        return { status: response.status, type: response.headers.get('content-type'), events };
      } finally {
        await app.close();
      }
    }

    it('streams progress, then one finished reply', async () => {
      const { deps, llm } = await setup(prisma);
      llm.load([IDENTIFY, { say: 'Hello Rahim.' }]);
      const { status, type, events } = await chat(await buildServer(deps), {
        message: 'Rahim Uddin, 12 March 1985',
      });
      assert.equal(status, 200);
      assert.match(type, /text\/event-stream/);
      assert.deepEqual(events.map((e) => e.event), ['conversation', 'progress', 'reply', 'done']);
      assert.equal(events[1].data.tool, 'find_patient');
      assert.deepEqual(events[2].data, { text: 'Hello Rahim.', handedOff: false });
    });

    it('continues a conversation by id', async () => {
      const { deps, llm, conversationId } = await setup(prisma);
      llm.load([{ say: 'Hi again.' }]);
      const { events } = await chat(await buildServer(deps), { conversationId, message: 'Hello' });
      assert.equal(events[0].data.id, conversationId);
      assert.equal(await prisma.conversation.count(), 1);
    });

    it('tells the widget when a person has taken over', async () => {
      const { deps } = await setup(prisma);
      const { events } = await chat(await buildServer(deps), { message: 'I want to talk to a real person' });
      assert.equal(events.find((e) => e.event === 'reply').data.handedOff, true);
    });

    it('starts in the language the widget asked for', async () => {
      const { deps, llm } = await setup(prisma);
      llm.load([{ say: 'ঠিক আছে।' }]);
      await chat(await buildServer(deps), { message: '১০', language: 'bn' });
      assert.match(llm.requests[0].at(-1).content, /Reply in: Bangla/);
    });

    it('rejects an empty message and an unknown conversation', async () => {
      const { deps } = await setup(prisma);
      assert.equal((await chat(await buildServer(deps), { message: '   ' })).status, 400);
      assert.equal((await chat(await buildServer(deps), { conversationId: 'nope', message: 'Hi' })).status, 404);
    });

    it('does not continue another channel’s conversation', async () => {
      const { deps, conversationId } = await setup(prisma, { channel: 'whatsapp' });
      assert.equal((await chat(await buildServer(deps), { conversationId, message: 'Hi' })).status, 404);
    });

    it('sends an error event instead of hanging when a turn fails', async () => {
      const { deps } = await setup(prisma);
      const broken = {
        ...deps,
        calendar: {
          listProviders: async () => {
            throw new Error('down');
          },
        },
      };
      const { events } = await chat(await buildServer(broken), { message: 'Hello' });
      assert.deepEqual(events.map((e) => e.event), ['conversation', 'error', 'done']);
    });

    it('serves the widget and a health check', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps);
      const page = await app.inject({ method: 'GET', url: '/' });
      assert.equal(page.statusCode, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.match(page.body, /বাংলা/);
      assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().status, 'ok');
      await app.close();
    });
  });

  describe('whatsapp', () => {
    const SECRET = 'app-secret';
    const whatsapp = {
      verifyToken: 'verify-me',
      appSecret: SECRET,
      accessToken: 'token',
      phoneNumberId: '123',
      apiVersion: 'v23.0',
    };
    const FROM = RAHIM.phone.slice(1);

    const payload = (messages) => ({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages } }] }],
    });
    const textMessage = (id, body) => ({ id, from: FROM, type: 'text', text: { body } });
    const sign = (raw, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

    async function build(deps) {
      const sent = [];
      const fetchImpl = async (url, init) => {
        sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return new Response('{}', { status: 200 });
      };
      const app = await buildServer(deps, { whatsapp, fetchImpl, awaitProcessing: true });
      return { app, sent };
    }

    const post = (app, body, signature) => {
      const raw = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: '/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(raw) },
        payload: raw,
      });
    };

    it('answers Meta’s verification handshake', async () => {
      const { deps } = await setup(prisma);
      const { app } = await build(deps);
      const query = 'hub.mode=subscribe&hub.challenge=4242&hub.verify_token=';
      const good = await app.inject({ method: 'GET', url: `/whatsapp?${query}verify-me` });
      assert.equal(good.statusCode, 200);
      assert.equal(good.body, '4242');
      assert.equal((await app.inject({ method: 'GET', url: `/whatsapp?${query}wrong` })).statusCode, 403);
      await app.close();
    });

    it('fails closed when no verify token is configured', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { whatsapp: { ...whatsapp, verifyToken: undefined } });
      const response = await app.inject({ method: 'GET', url: '/whatsapp?hub.mode=subscribe&hub.challenge=1' });
      assert.equal(response.statusCode, 403);
      await app.close();
    });

    it('rejects a bad signature before doing anything', async () => {
      const { deps, llm } = await setup(prisma);
      const { app, sent } = await build(deps);
      const body = payload([textMessage('wamid.1', 'Hello')]);
      const raw = JSON.stringify(body);
      assert.equal((await post(app, body, sign(raw, 'wrong-secret'))).statusCode, 403);
      assert.equal((await post(app, body, 'sha256=abcd')).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/whatsapp', headers: { 'content-type': 'application/json' }, payload: raw })).statusCode, 403);
      assert.equal(llm.requests.length, 0);
      assert.equal(sent.length, 0);
      await app.close();
    });

    it('runs a turn and replies through the Graph API', async () => {
      const { deps, llm } = await setup(prisma);
      const { app, sent } = await build(deps);
      llm.load([{ say: 'Hello!' }]);
      const response = await post(app, payload([textMessage('wamid.2', 'Hello')]));

      assert.equal(response.statusCode, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, 'https://graph.facebook.com/v23.0/123/messages');
      assert.equal(sent[0].headers.Authorization, 'Bearer token');
      assert.deepEqual(sent[0].body, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: FROM,
        type: 'text',
        text: { body: 'Hello!' },
      });
      await app.close();
    });

    it('uses the sender’s number as an identity hint', async () => {
      const { deps, llm } = await setup(prisma);
      const { app } = await build(deps);
      llm.load([{ call: 'find_patient', input: { name: 'Rahim' } }, { say: 'Hello Rahim.' }]);
      await post(app, payload([textMessage('wamid.3', 'This is Rahim')]));
      const conversation = await prisma.conversation.findFirst({ where: { channel: 'whatsapp' } });
      assert.equal(conversation.state.callerPhone, RAHIM.phone);
      assert.equal(conversation.patientId, 'p1');
      await app.close();
    });

    it('keeps one conversation per sender', async () => {
      const { deps, llm } = await setup(prisma);
      const { app } = await build(deps);
      llm.load([{ say: 'One.' }, { say: 'Two.' }]);
      await post(app, payload([textMessage('wamid.4', 'First')]));
      await post(app, payload([textMessage('wamid.5', 'Second')]));
      assert.equal(await prisma.conversation.count({ where: { channel: 'whatsapp' } }), 1);
      await app.close();
    });

    it('does not reply twice when Meta retries a webhook', async () => {
      const { deps, llm } = await setup(prisma);
      const { app, sent } = await build(deps);
      llm.load([{ say: 'Hello!' }]);
      const body = payload([textMessage('wamid.6', 'Hello')]);
      await post(app, body);
      await post(app, body);
      assert.equal(sent.length, 1);
      assert.equal(llm.requests.length, 1);
      await app.close();
    });

    it('explains that it only reads text', async () => {
      const { deps, llm } = await setup(prisma);
      const { app, sent } = await build(deps);
      await post(app, payload([{ id: 'wamid.7', from: FROM, type: 'image', image: {} }]));
      assert.match(sent[0].body.text.body, /text messages/);
      assert.equal(llm.requests.length, 0);
      await app.close();
    });

    it('ignores delivery receipts', async () => {
      const { deps } = await setup(prisma);
      const { app, sent } = await build(deps);
      const receipt = { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }] };
      assert.equal((await post(app, receipt)).statusCode, 200);
      assert.equal(sent.length, 0);
      await app.close();
    });
  });

  describe('vapi', () => {
    const SECRET = 'vapi-secret';
    const call = { id: 'call-1', customer: { number: RAHIM.phone } };
    const auth = { authorization: `Bearer ${SECRET}` };
    const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
    const message = (toolCallList) => ({ message: { type: 'tool-calls', call, toolCallList } });

    const post = (app, payload, headers = auth, url = `/vapi/tools/${TURN_TOOL}`) =>
      app.inject({ method: 'POST', url, headers, payload });

    it('rejects a missing or wrong secret', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      const body = message([]);
      assert.equal((await post(app, body, {})).statusCode, 401);
      assert.equal((await post(app, body, { authorization: 'Bearer wrong' })).statusCode, 401);
      assert.equal((await post(app, body, { 'x-vapi-secret': SECRET })).statusCode, 200);
      await app.close();
    });

    it('fails closed when no secret is configured', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: '' });
      assert.equal((await post(app, message([]), { authorization: 'Bearer ' })).statusCode, 401);
      await app.close();
    });

    it('runs a full turn and returns one line of text', async () => {
      const { deps, llm } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      llm.load([{ say: 'Hello.\nHow can I help?' }]);
      const response = await post(app, message([toolCall('tc1', TURN_TOOL, { utterance: 'Hello' })]));
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().results, [
        { toolCallId: 'tc1', name: TURN_TOOL, result: 'Hello. How can I help?' },
      ]);
      await app.close();
    });

    it('applies the reply guards in a full turn', async () => {
      const { deps, llm } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      llm.load([{ say: 'You are booked for 9:00 AM on Tuesday.' }, { say: 'You are booked for 9:00 AM on Tuesday.' }]);
      const { results } = (await post(app, message([toolCall('tc2', TURN_TOOL, { utterance: 'Book me' })]))).json();
      assert.doesNotMatch(results[0].result, /booked/);
      assert.match(results[0].result, /staff/);
      await app.close();
    });

    it('uses caller ID as an identity hint', async () => {
      const { deps, llm } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      llm.load([{ call: 'find_patient', input: { name: 'Rahim' } }, { say: 'Hello Rahim.' }]);
      await post(app, message([toolCall('tc3', TURN_TOOL, { utterance: 'This is Rahim' })]));
      const conversation = await prisma.conversation.findFirst({ where: { channel: 'vapi' } });
      assert.equal(conversation.externalId, 'call-1');
      assert.equal(conversation.patientId, 'p1');
      await app.close();
    });

    it('runs individual tools through the same guards', async () => {
      const { deps, calendar } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      const book = toolCall('tc4', 'create_booking', { patient_id: 'p1', provider_id: 'dr_karim', start: '2026-11-10T10:00:00+06:00' });

      // Blocked: nobody has been identified on this call yet.
      const blocked = (await post(app, message([book]))).json().results[0];
      assert.match(blocked.error, /identity_gate_blocked/);
      assert.equal('result' in blocked, false);
      assert.equal(calendar.snapshot().length, 0);

      const found = await post(app, message([toolCall('tc5', 'find_patient', { name: 'Rahim' })]));
      assert.equal(JSON.parse(found.json().results[0].result).status, 'resolved');

      const booked = (await post(app, message([{ ...book, id: 'tc6' }]))).json().results[0];
      assert.equal(JSON.parse(booked.result).verified, true);
      assert.equal(new Date(calendar.snapshot()[0].start).getTime(), at('2026-11-10T10:00').getTime());
      await app.close();
    });

    it('accepts arguments sent as a JSON string', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      const response = await post(app, message([toolCall('tc7', 'find_patient', JSON.stringify({ name: 'Rahim' }))]));
      assert.equal(JSON.parse(response.json().results[0].result).status, 'resolved');
      await app.close();
    });

    it('answers 200 with a per-call error for bad calls', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      const response = await post(app, message([
        toolCall('tc8', 'nonsense', {}),
        toolCall('tc9', TURN_TOOL, { utterance: '  ' }),
        toolCall('tc10', 'find_patient', '{not json'),
      ]));
      assert.equal(response.statusCode, 200);
      const { results } = response.json();
      assert.match(results[0].error, /Unknown tool/);
      assert.match(results[1].error, /empty/);
      assert.match(results[2].error, /staff/);
      await app.close();
    });

    it('stores the call transcript once, however often it is reported', async () => {
      const { deps } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      const report = {
        message: {
          type: 'end-of-call-report',
          endedReason: 'hangup',
          call,
          artifact: {
            messages: [
              { role: 'system', message: 'You are a receptionist' },
              { role: 'assistant', message: 'How can I help?' },
              { role: 'user', message: 'Book me in' },
            ],
          },
        },
      };
      assert.equal((await post(app, report, auth, '/vapi/events')).statusCode, 200);
      await post(app, report, auth, '/vapi/events');
      const rows = await prisma.message.findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(rows.map((r) => [r.role, r.kind, r.content]), [
        ['assistant', 'display', 'How can I help?'],
        ['user', 'display', 'Book me in'],
      ]);
      assert.ok(await prisma.auditLog.findFirst({ where: { action: 'call.ended' } }));
      await app.close();
    });

    it('keeps a transcript out of what is replayed to the model', async () => {
      const { deps, llm } = await setup(prisma);
      const app = await buildServer(deps, { vapiSecret: SECRET });
      await post(app, {
        message: { type: 'end-of-call-report', call, artifact: { messages: [{ role: 'user', message: 'Earlier words' }] } },
      }, auth, '/vapi/events');
      llm.load([{ say: 'Hello.' }]);
      await post(app, message([toolCall('tc11', TURN_TOOL, { utterance: 'Hello' })]));
      assert.doesNotMatch(JSON.stringify(llm.requests[0]), /Earlier words/);
      await app.close();
    });
  });
});
