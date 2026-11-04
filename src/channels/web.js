import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { runTurn, startConversation } from '../agent/turn.js';

const WIDGET_PATH = fileURLToPath(new URL('../../web-widget/index.html', import.meta.url));

const ChatBody = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(2000),
  language: z.enum(['en', 'bn']).optional(),
});

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
