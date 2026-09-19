import { Router, type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getActiveChannel } from '../../channels/registry.js';
import type { BaileysChannel } from '../../channels/baileys.js';

const log = logger.child({ mod: 'admin' });

/**
 * Shared-token auth. Documented in the README as the next thing to replace —
 * it is adequate for a demo with one operator and nothing more.
 */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const token = (req.query.token as string) ?? req.get('x-admin-token') ?? '';
  if (token !== config.ADMIN_TOKEN) {
    res.status(401).json({ error: 'bad or missing token' });
    return;
  }
  next();
}

function whatsapp(): BaileysChannel | null {
  const ch = getActiveChannel();
  return ch && ch.name === 'whatsapp' ? (ch as BaileysChannel) : null;
}

export function adminRouter(): Router {
  const router = Router();
  router.use('/admin', requireToken);

  router.get('/admin/status', (_req, res) => {
    const ch = getActiveChannel();
    res.json({ channel: ch?.name ?? 'none', ...(ch?.status() ?? {}) });
  });

  /**
   * Pairing code beats scanning a QR out of a cloud log viewer: request one for
   * the bot's number, then on that phone use
   * WhatsApp → Linked devices → Link with phone number instead.
   */
  router.get('/admin/pair', async (req, res) => {
    const ch = whatsapp();
    if (!ch) {
      res.status(400).json({ error: 'WhatsApp channel is not active (CHANNEL=whatsapp?)' });
      return;
    }
    const phone = (req.query.phone as string) || config.WA_PAIRING_NUMBER;
    if (!phone) {
      res.status(400).json({ error: 'pass ?phone=919876543210 or set WA_PAIRING_NUMBER' });
      return;
    }
    try {
      const pairingCode = await ch.requestPairingCode(phone);
      res.json({
        pairingCode,
        phone,
        next: 'On that phone: WhatsApp → Settings → Linked devices → Link with phone number instead',
      });
    } catch (err) {
      log.error({ err }, 'pairing failed');
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.get('/admin/qr', async (_req, res) => {
    const ch = whatsapp();
    const qr = ch?.currentQr();
    if (!qr) {
      res.status(404).json({ error: 'no QR available right now — already paired, or still connecting' });
      return;
    }
    const png = await QRCode.toBuffer(qr, { width: 420, margin: 2 });
    res.type('png').send(png);
  });

  /** Wipes the stored session and forces a fresh pairing. Deliberately blunt. */
  router.post('/admin/logout', async (_req, res) => {
    const ch = whatsapp();
    if (!ch) {
      res.status(400).json({ error: 'WhatsApp channel is not active' });
      return;
    }
    await ch.logoutAndClear();
    res.json({ ok: true, note: 'stored credentials cleared — request a new pairing code' });
  });

  return router;
}
