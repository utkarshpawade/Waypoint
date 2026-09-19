import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { adminRouter } from './routes/admin.js';
import { consoleRouter } from './routes/console.js';
import { healthRouter } from './routes/health.js';
import { payRouter } from './routes/pay.js';
import { webhookRouter } from './routes/webhook.js';

const log = logger.child({ mod: 'web' });
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Express and the WhatsApp socket share one process: Render's free tier gives
 * one service, and it lets /health report the real connection state.
 */
export function createServer() {
  const app = express();
  app.use(
    express.json({
      limit: '256kb',
      // Keep the raw bytes: Meta signs the exact body, and re-serialising the
      // parsed object would not reproduce the same signature.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.disable('x-powered-by');

  app.use(healthRouter());
  app.use(webhookRouter());
  app.use(adminRouter());
  app.use(payRouter());
  app.use(consoleRouter());

  app.get('/console', (_req, res) => {
    res.sendFile(join(here, '..', '..', 'public', 'console.html'));
  });

  app.get('/', (_req, res) => {
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Waypoint</title>
       <style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1b1b1b}
       code{background:#f1f3f5;padding:.15em .4em;border-radius:4px}</style>
       <h1>Waypoint ✈️</h1>
       <p>A WhatsApp flight concierge. This process is alive; the bot lives on WhatsApp.</p>
       <p><a href="/health">/health</a> · <code>/console?token=…</code> · <code>/admin/pair?token=…</code></p>`,
    );
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  return app;
}

export function startServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer().listen(config.PORT, () => {
      log.info({ port: config.PORT, baseUrl: config.publicBaseUrl }, 'http listening');
      resolve(server);
    });
  });
}
