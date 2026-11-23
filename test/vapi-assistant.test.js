import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assistantConfig, pushAssistant } from '../scripts/vapi-assistant.js';
import { handoffMessage } from '../src/guards/handoff-triggers.js';

const OPTIONS = { publicUrl: 'https://receptionist.example.com', secret: 's3cret', clinicName: 'Artic Maze Clinic' };

describe('vapi assistant', () => {
  it('makes this server the model, behind the shared secret', () => {
    const { model } = assistantConfig(OPTIONS);
    assert.equal(model.provider, 'custom-llm');
    // Vapi treats it as a base URL and adds /chat/completions, which is the route served.
    assert.equal(model.url, 'https://receptionist.example.com/vapi/llm');
    assert.deepEqual(model.headers, { 'x-vapi-secret': 's3cret' });
    assert.equal(model.metadataSendMode, 'variable');
  });

  it('puts the secret nowhere a browser caller could redirect', () => {
    const config = assistantConfig(OPTIONS);
    assert.equal('server' in config, false);
    assert.equal(JSON.stringify({ ...config, model: { ...config.model, headers: {} } }).includes('s3cret'), false);
  });

  it('hangs up on the words that end every handoff on a call', () => {
    const { endCallPhrases } = assistantConfig(OPTIONS);
    for (const language of ['en', 'es', 'bn']) {
      const reply = handoffMessage('default', language, { voice: true, phoneKnown: true });
      assert.ok(endCallPhrases.some((phrase) => reply.toLowerCase().endsWith(phrase.toLowerCase())), reply);
    }
  });

  it('keeps the name within Vapi’s 40 characters', () => {
    assert.ok(assistantConfig({ ...OPTIONS, clinicName: 'A Very Long Clinic Name That Goes On And On' }).name.length <= 40);
  });

  it('creates an assistant, or updates the one it is given', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'asst_1' }), { status: 200 });
    };
    const body = assistantConfig(OPTIONS);
    assert.equal((await pushAssistant(body, { apiKey: 'priv', fetchImpl })).id, 'asst_1');
    await pushAssistant(body, { apiKey: 'priv', assistantId: 'asst_1', fetchImpl });
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [
      ['POST', 'https://api.vapi.ai/assistant', 'Bearer priv'],
      ['PATCH', 'https://api.vapi.ai/assistant/asst_1', 'Bearer priv'],
    ]);
    assert.equal(calls[0].body.model.url, body.model.url);
  });

  it('says why Vapi couldn’t be reached', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN api.vapi.ai'), { code: 'EAI_AGAIN' }) });
    };
    await assert.rejects(pushAssistant(assistantConfig(OPTIONS), { apiKey: 'priv', fetchImpl }), /reach api\.vapi\.ai \(EAI_AGAIN\)/);
  });

  it('reports what Vapi rejected', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: ['voice.voiceId must be a string'] }), { status: 400 });
    await assert.rejects(
      pushAssistant(assistantConfig(OPTIONS), { apiKey: 'priv', fetchImpl }),
      /400: \["voice.voiceId must be a string"\]/,
    );
  });
});
