import { pathToFileURL } from 'node:url';

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { ClaudeClient } from './agent/llm.js';
import { CalcomAdapter } from './calendar/calcom.js';
import { demoCalendar } from './calendar/demo.js';
import { FakeAdapter } from './calendar/fake.js';
import { registerVapiChannel } from './channels/vapi.js';
import { registerWebChannel } from './channels/web.js';
import { registerWhatsappChannel } from './channels/whatsapp.js';
import { config } from './config.js';
import { createPrisma } from './db/client.js';

/**
 * @param {import('./agent/turn.js').Deps} deps
 * @param {object} [options]  overrides for tests
 */
export async function buildServer(deps, options = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(rateLimit, { global: false });

  registerWebChannel(app, deps);
  registerWhatsappChannel(app, deps, {
    whatsapp: options.whatsapp ?? config.whatsapp,
    fetchImpl: options.fetchImpl,
    awaitProcessing: options.awaitProcessing,
  });
  registerVapiChannel(app, deps, { secret: options.vapiSecret ?? config.vapi.secret });

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

function buildCalendar() {
  if (config.calendar.adapter === 'calcom') {
    return new CalcomAdapter({ ...config.calendar.calcom, tz: config.tz });
  }
  const calendar = new FakeAdapter();
  calendar.seed(demoCalendar(new Date(), config.tz));
  return calendar;
}

async function main() {
  const deps = {
    prisma: createPrisma(config.databaseUrl),
    calendar: buildCalendar(),
    llm: new ClaudeClient(config.llm),
    tz: config.tz,
    clinicName: config.clinicName,
  };
  const app = await buildServer(deps, { logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
