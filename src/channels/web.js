import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { runTurn, startConversation } from '../agent/turn.js';
import { config } from '../config.js';
import { addDays, clockLabels, dayBounds, labelParts, localParts, parseLocal, toLocalIso } from '../time.js';

const WIDGET_PATH = fileURLToPath(new URL('../../web-widget/index.html', import.meta.url));

const ChatBody = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(2000),
  language: z.enum(['en', 'es', 'bn']).optional(),
});

/** Days of free slots the homepage shows, starting today. */
export const DIRECTORY_DAYS = 7;

/**
 * What the public homepage shows: the doctors, their weekly hours and free slots, and
 * the fictional demo patients a visitor can try the receptionist as. Everything comes
 * through the calendar adapter, so booked slots disappear here as they do for the agent.
 * Patients who register through a channel are never listed.
 */
export async function clinicDirectory(deps) {
  const { prisma, calendar } = deps;
  const tz = deps.tz ?? config.tz;
  const now = (deps.clock ?? (() => new Date()))();
  const today = localParts(now, tz).dateKey;
  const dates = Array.from({ length: DIRECTORY_DAYS }, (_, i) => addDays(today, i));
  const from = dayBounds(dates[0], tz).start;
  const to = dayBounds(dates.at(-1), tz).end;

  const [providers, hours, patients] = await Promise.all([
    calendar.listProviders(),
    calendar.weeklyHours ? calendar.weeklyHours() : null,
    prisma.patient.findMany({
      where: { demo: true },
      orderBy: [{ name: 'asc' }, { dob: 'asc' }],
      select: { name: true, nameBn: true, dob: true, phone: true },
    }),
  ]);

  const withSlots = await Promise.all(
    providers.map(async (provider) => {
      const free = await calendar.getAvailability({ providerId: provider.id, from, to });
      const slots = Object.fromEntries(dates.map((date) => [date, []]));
      for (const slot of free) {
        const label = labelParts(slot.start, tz);
        slots[localParts(slot.start, tz).dateKey]?.push({
          start: toLocalIso(slot.start, tz),
          time_en: label.time_en,
          time_es: label.time_es,
          time_bn: label.time_bn,
        });
      }
      const own = hours?.filter((h) => h.providerId === provider.id);
      return {
        id: provider.id,
        name: provider.name,
        nameBn: provider.nameBn ?? null,
        specialty: provider.specialty ?? null,
        // Null when the calendar can't say, as with Cal.com: the slots still show.
        hours: own
          ? own.map((h) => ({
              weekday: h.weekday,
              start_en: clockLabels(h.startMinute).en,
              start_es: clockLabels(h.startMinute).es,
              start_bn: clockLabels(h.startMinute).bn,
              end_en: clockLabels(h.endMinute).en,
              end_es: clockLabels(h.endMinute).es,
              end_bn: clockLabels(h.endMinute).bn,
            }))
          : null,
        slots,
      };
    }),
  );

  return {
    clinic: { name: deps.clinicName ?? config.clinicName, timezone: tz },
    days: dates.map((date) => {
      const label = labelParts(parseLocal(`${date}T12:00`, tz), tz);
      return { date, label_en: label.date_en, label_es: label.date_es, label_bn: label.date_bn };
    }),
    providers: withSlots,
    patients,
  };
}

/**
 * POST /chat answers over server-sent events: which tools are running, then the
 * finished reply. The reply is never streamed word by word, because the guards have
 * to pass all of it before the patient sees any of it.
 */
export function registerWebChannel(app, deps) {
  const { prisma } = deps;

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(WIDGET_PATH);
  });

  app.get(
    '/api/clinic',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store');
        return await clinicDirectory(deps);
      } catch (error) {
        request.log.error({ err: error }, 'clinic directory failed');
        return reply.code(503).send({ error: 'directory_unavailable' });
      }
    },
  );

  app.post(
    '/chat',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = ChatBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const { conversationId, message, language } = parsed.data;

      let conversation;
      if (conversationId) {
        conversation = await prisma.conversation.findFirst({ where: { id: conversationId, channel: 'web' } });
        if (!conversation) return reply.code(404).send({ error: 'conversation_not_found' });
        if (language && language !== conversation.language) {
          conversation = await prisma.conversation.update({ where: { id: conversationId }, data: { language } });
        }
      } else {
        conversation = await startConversation(prisma, { channel: 'web', language });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (event, data) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('conversation', { id: conversation.id });
      try {
        const result = await runTurn(deps, {
          conversationId: conversation.id,
          text: message,
          onEvent: ({ name }) => send('progress', { tool: name }),
        });
        send('reply', { text: result.reply, handedOff: result.status === 'handed_off' });
      } catch (error) {
        request.log.error({ err: error, conversationId: conversation.id }, 'chat turn failed');
        send('error', { code: 'turn_failed' });
      }
      send('done', {});
      reply.raw.end();
      return reply;
    },
  );
}
