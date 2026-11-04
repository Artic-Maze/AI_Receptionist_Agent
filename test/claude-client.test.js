import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';

import { ClaudeClient } from '../src/agent/llm.js';
import { LLM_TOOLS } from '../src/tools/index.js';

// A local stand-in for the API. It checks what the SDK actually puts on the wire, but
// it proves nothing about how the real API responds: that takes a live run.
describe('ClaudeClient', () => {
  let server;
  let baseURL;
  let received;
  let respondWith;

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respondWith));
      });
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => {
    server.close(resolve);
  }));

  const message = (content, extra = {}) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    content,
    ...extra,
  });

  const build = (options = {}) =>
    new ClaudeClient({
      model: 'claude-opus-5-5',
      effort: 'medium',
      client: new Anthropic({ apiKey: 'test', baseURL, maxRetries: 0 }),
      ...options,
    });

  const request = { system: 'You are a receptionist.', tools: LLM_TOOLS, messages: [{ role: 'user', content: 'Hi' }] };

  it('sends a request the current API accepts', async () => {
    respondWith = message([{ type: 'text', text: 'Hello' }]);
    await build().complete(request);
    const { body, headers } = received;

    assert.equal(body.model, 'claude-opus-5-5');
    // Rejected with a 400 on this model and API version, so they must never be sent.
    assert.equal('temperature' in body, false);
    assert.equal('top_p' in body, false);
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.tool_choice.type, 'auto');
    assert.equal(body.tool_choice.disable_parallel_tool_use, true);
    assert.equal(body.output_config.effort, 'medium');
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.cache_control.type, 'ephemeral');
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.match(headers['anthropic-beta'], /thinking-binding-controls-2026-08-01/);
    assert.equal(headers['anthropic-version'], '2026-10-21');
  });

  it('defaults to degrading on a prefix mismatch, and can fail instead', async () => {
    respondWith = message([{ type: 'text', text: 'Hello' }]);
    await build().complete(request);
    assert.equal(received.body.thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
    await build({ prefixMismatch: 'error' }).complete(request);
    assert.equal(received.body.thinking.block_binding.prefix_mismatch_behavior, 'error');
  });

  it('sends well-formed tool definitions', async () => {
    respondWith = message([{ type: 'text', text: 'Hello' }]);
    await build().complete(request);
    const names = received.body.tools.map((t) => t.name);
    assert.deepEqual(names, [
      'find_patient',
      'check_availability',
      'create_booking',
      'reschedule_booking',
      'cancel_booking',
      'get_booking',
      'handoff_to_human',
    ]);
    for (const tool of received.body.tools) {
      assert.equal(tool.input_schema.type, 'object');
      assert.equal('$schema' in tool.input_schema, false);
      assert.ok(tool.description.length > 20);
    }
    const create = received.body.tools.find((t) => t.name === 'create_booking');
    assert.deepEqual(create.input_schema.required.sort(), ['patient_id', 'provider_id', 'start']);
  });

  it('reads replies by block type, since thinking blocks can come first', async () => {
    respondWith = message([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Hello' },
    ]);
    const response = await build().complete(request);
    assert.equal(response.text, 'Hello');
    assert.equal(response.stopReason, 'end_turn');
    assert.equal(response.content[0].signature, 'sig');
    assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 });
  });

  it('returns tool calls', async () => {
    respondWith = message(
      [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'find_patient', input: { name: 'Rahim' } },
      ],
      { stop_reason: 'tool_use' },
    );
    const response = await build().complete(request);
    assert.deepEqual(response.toolUses, [{ id: 'toolu_1', name: 'find_patient', input: { name: 'Rahim' } }]);
    assert.equal(response.content.length, 2);
  });

  it('replays only what is allowed after a fallback', async () => {
    respondWith = message([
      { type: 'thinking', thinking: '', signature: 'old' },
      { type: 'text', text: 'Partial. ' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'thinking', thinking: '', signature: 'new' },
      { type: 'text', text: 'Hello' },
    ]);
    const response = await build().complete(request);
    assert.deepEqual(response.content.map((b) => b.signature ?? b.text), ['Partial. ', 'new', 'Hello']);
  });

  it('surfaces a refusal as a stop reason', async () => {
    respondWith = message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } });
    const response = await build().complete(request);
    assert.equal(response.stopReason, 'refusal');
    assert.equal(response.text, '');
  });
});
