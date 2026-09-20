import { Router } from 'express';
import { config } from '../../config.js';
import { getStore } from '../../db/index.js';
import { getActiveChannel } from '../../channels/registry.js';
import { llm } from '../../llm/client.js';

const startedAt = Date.now();

/**
 * Doubles as the keep-alive endpoint (cron-job.org pings it every 10 minutes so
 * Render never sleeps) and as uptime monitoring — it reports whether WhatsApp
 * is actually connected, not just whether the process is alive.
 */
export function healthRouter(): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const channel = getActiveChannel();
    const wa = channel?.status() ?? { connected: false, state: 'not started' };
    const model = llm.status();

    let db: 'ok' | 'error' | 'memory' = getStore().kind === 'postgres' ? 'ok' : 'memory';
    if (getStore().kind === 'postgres') {
      try {
        await getStore().rawQuery('SELECT 1');
      } catch {
        db = 'error';
      }
    }

    res.status(200).json({
      ok: true,
      wa: wa.state,
      waConnected: wa.connected,
      channel: channel?.name ?? 'none',
      db,
      model: model.configured ? (model.circuitOpen ? 'circuit-open' : model.model) : 'rules-only',
      email: config.hasSmtp ? 'configured' : 'not configured',
      // Every payment link in every itinerary email is built from this, and
      // forgetting to set it after the first deploy is the classic mistake.
      // Surfacing it here makes a misconfigured deploy visible immediately
      // instead of at the moment a user taps a link to localhost.
      baseUrl: config.publicBaseUrl,
      baseUrlLooksDeployed: !/localhost|127\.0\.0\.1/.test(config.publicBaseUrl),
      uptime: Math.round((Date.now() - startedAt) / 1000),
      env: config.CHANNEL,
      ts: new Date().toISOString(),
    });
  });

  return router;
}
