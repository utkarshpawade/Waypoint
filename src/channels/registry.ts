import { logger } from '../logger.js';
import type { Channel } from './types.js';

/**
 * The single place that knows which channel is live. The escalation service,
 * the payment webhook and the SLA sweeper all need to send a message without
 * being handed a channel through six layers of call stack — and none of them
 * should import Baileys to do it.
 */
let active: Channel | null = null;

export function setActiveChannel(ch: Channel): void {
  active = ch;
}

export function getActiveChannel(): Channel | null {
  return active;
}

export async function sendTo(to: string, text: string): Promise<boolean> {
  if (!active) {
    logger.warn({ to }, 'no active channel — message dropped');
    return false;
  }
  try {
    await active.send(to, text);
    return true;
  } catch (err) {
    logger.error({ err, to }, 'send failed');
    return false;
  }
}
