import { Router, type Request } from 'express';
import { logger } from '../../logger.js';
import { getActiveChannel } from '../../channels/registry.js';
import { CloudApiChannel } from '../../channels/cloud-api.js';

const log = logger.child({ mod: 'webhook' });

function cloud(): CloudApiChannel | null {
  const ch = getActiveChannel();
  return ch instanceof CloudApiChannel ? ch : null;
}

/**
 * Meta's webhook. Two jobs: answer the subscription handshake once, then
 * receive every inbound message.
 *
 * It always returns 200 to a signed delivery, even when handling fails — Meta
 * retries non-200s with backoff and will eventually disable the subscription,
 * so a bug in our engine must not cost us the webhook. Processing happens after
 * the response for the same reason: Meta's timeout is short, and this bot calls
 * a model and a database on the way to a reply.
 */
export function webhookRouter(): Router {
  const router = Router();

  router.get('/webhook/whatsapp', (req, res) => {
    const ch = cloud();
    if (!ch) {
      res.status(503).send('cloud channel not active');
      return;
    }
    const challenge = ch.verifySubscription(req.query as Record<string, unknown>);
    if (challenge) res.status(200).send(challenge);
    else res.sendStatus(403);
  });

  router.post('/webhook/whatsapp', (req, res) => {
    const ch = cloud();
    if (!ch) {
      res.sendStatus(503);
      return;
    }

    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!ch.verifySignature(raw, req.get('x-hub-signature-256'))) {
      log.warn('rejected a webhook delivery with a bad signature');
      res.sendStatus(401);
      return;
    }

    res.sendStatus(200);
    ch.handleWebhook(req.body).catch((err) => log.error({ err }, 'webhook processing failed'));
  });

  return router;
}
