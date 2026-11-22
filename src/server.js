import { pathToFileURL } from 'node:url';

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { ClaudeClient } from './agent/llm.js';
import { CalcomAdapter } from './calendar/calcom.js';
import { DbCalendarAdapter } from './calendar/db.js';
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
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    // Addresses, never `true`, so a visitor can't pick their own rate-limit key.
    trustProxy: options.trustProxy ?? config.trustProxy,
  });
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

function buildCalendar(prisma) {
  const { adapter } = config.calendar;
  if (adapter === 'calcom') return new CalcomAdapter({ ...config.calendar.calcom, tz: config.tz });
  if (adapter === 'db') return new DbCalendarAdapter({ prisma, tz: config.tz });
  throw new Error(`Unknown CALENDAR_ADAPTER "${adapter}". Use "db" (the demo calendar in Postgres) or "calcom".`);
}

async function main() {
  const prisma = createPrisma(config.databaseUrl);
  const deps = {
    prisma,
    calendar: buildCalendar(prisma),
    llm: new ClaudeClient(config.llm),
    tz: config.tz,
    clinicName: config.clinicName,
  };
  const app = await buildServer(deps, { logger: true });
  if ((await deps.calendar.listProviders()).length === 0) {
    app.log.warn('The calendar has no providers. For the demo calendar, run `npm run db:seed`.');
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
