import { pathToFileURL } from 'node:url';

import { config } from '../src/config.js';
import { VOICE_GOODBYE } from '../src/guards/handoff-triggers.js';

/**
 * Speech in and out. Bangla narrows the choice: Google's transcriber lists Bengali and
 * a Multilingual mode, and of ElevenLabs' models only v3 speaks Bangla. Neither has
 * been tried on a real call yet, so both can be replaced with VAPI_TRANSCRIBER and
 * VAPI_VOICE, as JSON in Vapi's own format.
 */
export const DEFAULT_TRANSCRIBER = { provider: 'google', language: 'Multilingual' };
export const DEFAULT_VOICE = { provider: '11labs', model: 'eleven_v3', voiceId: 'sarah' };

/**
 * The Vapi assistant: this server as its model, so every word it says has passed the
 * guards. No server webhook is set, so the secret goes nowhere else: a browser caller
 * can override an assistant's webhook, but not its model's URL.
 */
export function assistantConfig({
  publicUrl,
  secret,
  clinicName,
  transcriber = DEFAULT_TRANSCRIBER,
  voice = DEFAULT_VOICE,
}) {
  return {
    name: `${clinicName} receptionist`.slice(0, 40),
    firstMessage:
      `Hello, this is ${clinicName}. How can I help you today? ` +
      'আপনি বাংলায়ও কথা বলতে পারেন। También puede hablar en español.',
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'custom-llm',
      // A base URL: Vapi adds /chat/completions.
      url: `${publicUrl}/vapi/llm`,
      model: 'receptionist',
      headers: { 'x-vapi-secret': secret },
      // Sends the call id and caller number, which tie each request to its conversation.
      metadataSendMode: 'variable',
      // A turn may run several tools before it says anything.
      timeoutSeconds: 60,
    },
    transcriber,
    voice,
    // The agent's goodbye, and the end of every handoff message on a call.
    endCallPhrases: Object.values(VOICE_GOODBYE),
    // So the wait while a turn runs doesn't sound like a dropped line.
    backgroundSound: 'office',
    maxDurationSeconds: 900,
  };
}

/** Creates the assistant, or updates it when there is an id. */
export async function pushAssistant(body, { apiKey, assistantId, fetchImpl = fetch }) {
  const url = `https://api.vapi.ai/assistant${assistantId ? `/${encodeURIComponent(assistantId)}` : ''}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: assistantId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Node's own message is just "fetch failed"; the reason is in its cause.
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new Error(`Couldn't reach api.vapi.ai (${reason}). This needs internet access, which a container on an internal Docker network doesn't have.`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Vapi answered ${response.status}: ${JSON.stringify(result.message ?? result)}`);
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function jsonEnv(name) {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return fail(`${name} is not valid JSON.`);
  }
}

async function main() {
  const push = process.argv.includes('--push');
  const { publicUrl } = config;
  const { secret, apiKey, assistantId } = config.vapi;

  if (!publicUrl) fail('Set PUBLIC_URL in .env: the https address where Vapi can reach this server.');
  const { protocol, hostname } = new URL(publicUrl);
  if (protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    fail('PUBLIC_URL must be public and https, which Vapi requires. For a local server, use a tunnel.');
  }
  if (!secret) fail('Set VAPI_SECRET in .env: any long random string.');

  const body = assistantConfig({
    publicUrl,
    secret,
    clinicName: config.clinicName,
    transcriber: jsonEnv('VAPI_TRANSCRIBER'),
    voice: jsonEnv('VAPI_VOICE'),
  });

  if (!push) {
    const shown = { ...body, model: { ...body.model, headers: { 'x-vapi-secret': '<VAPI_SECRET>' } } };
    console.log(JSON.stringify(shown, null, 2));
    console.log('\nRun `npm run vapi:assistant -- --push` to create or update it in Vapi.');
    return;
  }

  if (!apiKey) fail('Set VAPI_API_KEY in .env: your private key, from the Vapi dashboard.');
  const assistant = await pushAssistant(body, { apiKey, assistantId });
  console.log(`${assistantId ? 'Updated' : 'Created'} assistant ${assistant.id}.`);
  if (!assistantId) console.log(`Set VAPI_ASSISTANT_ID=${assistant.id} in .env, so the next push updates it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    fail(error.message);
  }
}
