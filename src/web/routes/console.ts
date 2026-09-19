import { Router } from 'express';
import { getStore } from '../../db/index.js';
import { computeMetrics } from '../../metrics/analytics.js';
import { claimEscalation, resolveEscalation } from '../../escalation/service.js';
import { AGENT_NAME } from '../../escalation/owner-commands.js';
import { recordResolution } from '../../escalation/gaps.js';
import { sendTo } from '../../channels/registry.js';
import { logger } from '../../logger.js';
import { requireToken } from './admin.js';
import { addSseClient, pushConsoleEvent, removeSseClient } from '../sse.js';

const log = logger.child({ mod: 'console' });

export function consoleRouter(): Router {
  const router = Router();
  router.use('/api', requireToken);

  router.get('/api/escalations', async (_req, res) => {
    const store = getStore();
    const list = [...(await store.listEscalations('OPEN')), ...(await store.listEscalations('CLAIMED'))];
    const enriched = await Promise.all(
      list.map(async (e) => {
        const session = await store.getSession(e.sessionId);
        return {
          ...e,
          waitedMinutes: Math.round((Date.now() - new Date(e.createdAt).getTime()) / 60000),
          user: session?.displayName ?? session?.channelUserId.split('@')[0] ?? 'unknown',
          state: session?.state,
          trip: session?.slots.trip ?? {},
        };
      }),
    );
    res.json(enriched.sort((a, b) => b.waitedMinutes - a.waitedMinutes));
  });

  router.get('/api/escalations/:ticket/transcript', async (req, res) => {
    const store = getStore();
    const esc = await store.getEscalation(req.params.ticket.toUpperCase());
    if (!esc) {
      res.status(404).json({ error: 'unknown ticket' });
      return;
    }
    const messages = await store.recentMessages(esc.sessionId, 40);
    res.json({ escalation: esc, messages });
  });

  router.post('/api/escalations/:ticket/take', async (req, res) => {
    const esc = await claimEscalation(req.params.ticket.toUpperCase(), AGENT_NAME);
    if (!esc) {
      res.status(404).json({ error: 'unknown ticket' });
      return;
    }
    const session = await getStore().getSession(esc.sessionId);
    if (session) await sendTo(session.channelUserId, `👤 *${AGENT_NAME}* has joined the chat.`);
    pushConsoleEvent('ticket', { ticket: esc.ticket, status: 'CLAIMED' });
    res.json({ ok: true });
  });

  router.post('/api/escalations/:ticket/reply', async (req, res) => {
    const text = String((req.body as { text?: string })?.text ?? '').trim();
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const store = getStore();
    const esc = await store.getEscalation(req.params.ticket.toUpperCase());
    if (!esc) {
      res.status(404).json({ error: 'unknown ticket' });
      return;
    }
    const session = await store.getSession(esc.sessionId);
    if (!session) {
      res.status(404).json({ error: 'no session' });
      return;
    }
    if (esc.status === 'OPEN') await claimEscalation(esc.ticket, AGENT_NAME);
    await sendTo(session.channelUserId, `👤 *${AGENT_NAME}*:\n${text}`);
    await store.insertMessage({
      sessionId: session.id,
      direction: 'OUT',
      author: 'AGENT',
      body: text,
      intent: 'agent_reply',
    });
    pushConsoleEvent('message', { ticket: esc.ticket, author: 'AGENT', body: text });
    log.info({ ticket: esc.ticket }, 'agent reply from console');
    res.json({ ok: true });
  });

  router.post('/api/escalations/:ticket/return', async (req, res) => {
    const resolution = String((req.body as { resolution?: string })?.resolution ?? 'handled by agent');
    const result = await resolveEscalation(req.params.ticket.toUpperCase(), resolution);
    if (!result) {
      res.status(404).json({ error: 'unknown ticket' });
      return;
    }
    await recordResolution(result.session.id, result.escalation.ticket, resolution);
    await sendTo(
      result.session.channelUserId,
      `🤖 Thanks for holding — picking up from what ${AGENT_NAME.split(' ')[0]} sorted out. What would you like to do next?`,
    );
    pushConsoleEvent('ticket', { ticket: result.escalation.ticket, status: 'RESOLVED' });
    res.json({ ok: true, resumedState: result.session.state });
  });

  router.get('/api/metrics', async (_req, res) => {
    res.json(await computeMetrics());
  });

  router.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    const client = { write: (s: string) => res.write(s) };
    addSseClient(client);

    // Render's proxy closes idle connections; a comment frame keeps it warm.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      removeSseClient(client);
    });
  });

  return router;
}
