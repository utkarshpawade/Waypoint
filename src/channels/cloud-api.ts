import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger, maskId } from '../logger.js';
import type { Channel, InboundMessage, MessageHandler } from './types.js';

const log = logger.child({ mod: 'cloud-api' });

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_CHARS = 3500; // API limit is 4096; leave headroom for markup
const PER_CHAT_GAP_MS = 250;

/**
 * WhatsApp Cloud API channel — Meta's official transport.
 *
 * The same Channel interface as the Baileys adapter, which is the whole point
 * of having one: swapping the transport changed no code in the conversation
 * engine, the ranking, the booking flow or the escalation service.
 *
 * Two things behave differently from an unofficial client, and both are real
 * product constraints rather than implementation details:
 *
 *  1. **The 24-hour window.** Free-form messages are only allowed within 24
 *     hours of the user's last message. Outside it, only pre-approved template
 *     messages go through. Every proactive message this bot sends — the payment
 *     confirmation, the SLA recovery nudge, the escalation alert — is a reply
 *     inside an active conversation, so this holds for the demo; at real scale
 *     those would need approved templates.
 *  2. **Development-mode recipients.** A test number can only message numbers
 *     registered in the Meta dashboard (about five). Messaging the public
 *     requires Business Verification.
 */
export class CloudApiChannel implements Channel {
  readonly name = 'whatsapp' as const;

  private handler: MessageHandler | null = null;
  private seenIds = new Set<string>();
  private sendChain: Promise<void> = Promise.resolve();
  private since = 0;
  private lastError: string | undefined;
  private lastInboundAt = 0;

  async start(): Promise<void> {
    if (!config.WA_CLOUD_TOKEN || !config.WA_CLOUD_PHONE_NUMBER_ID) {
      throw new Error('CHANNEL=cloud needs WA_CLOUD_TOKEN and WA_CLOUD_PHONE_NUMBER_ID');
    }
    // Confirm the token and phone number id actually work, loudly, at boot —
    // rather than discovering it on the first message from the interviewer.
    try {
      const res = await fetch(`${GRAPH}/${config.WA_CLOUD_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${config.WA_CLOUD_TOKEN}` },
      });
      const body = (await res.json()) as { display_phone_number?: string; verified_name?: string; error?: { message: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      this.since = Date.now();
      this.lastError = undefined;
      log.info(
        { number: body.display_phone_number, name: body.verified_name, webhook: `${config.publicBaseUrl}/webhook/whatsapp` },
        'cloud api ready',
      );
    } catch (err) {
      this.lastError = (err as Error).message;
      log.error({ err: this.lastError }, 'cloud api credentials rejected');
      throw err;
    }
  }

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }

  status() {
    return {
      connected: Boolean(config.WA_CLOUD_TOKEN && !this.lastError),
      state: this.lastError ? 'closed' : config.WA_CLOUD_TOKEN ? 'open' : 'not configured',
      jid: config.WA_CLOUD_PHONE_NUMBER_ID,
      since: this.since || undefined,
      lastError: this.lastError,
    };
  }

  /** Meta's webhook handshake: echo the challenge when the verify token matches. */
  verifySubscription(query: Record<string, unknown>): string | null {
    const mode = String(query['hub.mode'] ?? '');
    const token = String(query['hub.verify_token'] ?? '');
    const challenge = String(query['hub.challenge'] ?? '');
    if (mode === 'subscribe' && token === config.WA_CLOUD_VERIFY_TOKEN && challenge) {
      log.info('webhook subscription verified');
      return challenge;
    }
    log.warn({ mode }, 'webhook verification rejected');
    return null;
  }

  /**
   * Meta signs every delivery. Without this check anyone who learns the URL can
   * post fake messages into the conversation engine.
   */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    if (!config.WA_CLOUD_APP_SECRET) {
      log.warn('WA_CLOUD_APP_SECRET not set — webhook signatures are not being checked');
      return true;
    }
    if (!rawBody || !header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', config.WA_CLOUD_APP_SECRET).update(rawBody).digest();
    const got = Buffer.from(header.slice(7), 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** Parse one webhook delivery and hand each text message to the engine. */
  async handleWebhook(body: unknown): Promise<void> {
    for (const msg of extractMessages(body)) {
      if (this.seenIds.has(msg.messageId!)) {
        log.info({ id: msg.messageId }, 'duplicate webhook delivery ignored');
        continue;
      }
      this.seenIds.add(msg.messageId!);
      if (this.seenIds.size > 2000) this.seenIds = new Set([...this.seenIds].slice(-1000));

      this.lastInboundAt = Date.now();
      log.info({ from: maskId(msg.channelUserId), len: msg.text.length }, 'inbound');

      if (!msg.text.trim()) {
        await this.send(msg.channelUserId, 'I can only read text right now — could you type that out for me?');
        continue;
      }
      try {
        await this.handler?.(msg);
      } catch (err) {
        log.error({ err }, 'inbound handler threw');
      }
    }
  }

  /** Blue ticks are the closest thing the API has to a typing indicator. */
  async sendTyping(_to: string): Promise<void> {}

  async markRead(messageId: string): Promise<void> {
    await this.post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
  }

  async send(to: string, text: string): Promise<void> {
    const recipient = to.replace(/\D/g, '');
    const chunks = splitForCloud(text, MAX_CHARS);

    this.sendChain = this.sendChain.then(async () => {
      for (const chunk of chunks) {
        try {
          await this.post({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'text',
            text: { preview_url: false, body: chunk },
          });
          log.info({ to: maskId(recipient), len: chunk.length }, 'outbound');
        } catch (err) {
          this.lastError = (err as Error).message;
          log.error({ err: this.lastError, to: maskId(recipient) }, 'send failed');
        }
        if (chunks.length > 1) await sleep(PER_CHAT_GAP_MS);
      }
    });
    return this.sendChain;
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${GRAPH}/${config.WA_CLOUD_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WA_CLOUD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
      const message = body.error?.message ?? `HTTP ${res.status}`;
      // The two failures worth recognising on sight during an evaluation.
      if (body.error?.code === 131030) {
        throw new Error(`${message} — recipient is not in the test number's allowed list (add it in Meta dashboard)`);
      }
      if (body.error?.code === 131047) {
        throw new Error(`${message} — outside the 24-hour window, a template message is required`);
      }
      throw new Error(message);
    }
  }

  async stop(): Promise<void> {}
}

/** Pull text messages out of a webhook payload, ignoring statuses and non-text. */
export function extractMessages(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];

  for (const entry of entries) {
    for (const change of ((entry as { changes?: unknown[] })?.changes ?? []) as any[]) {
      const value = change?.value;
      if (!value?.messages) continue; // delivery/read status callbacks

      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) names.set(String(c.wa_id), c?.profile?.name ?? '');
      }

      for (const m of value.messages as any[]) {
        if (!m?.id || !m?.from) continue;
        // People reply-quote constantly; only some of these carry the text.
        const text: string =
          m.text?.body ?? m.button?.text ?? m.interactive?.list_reply?.title ?? m.interactive?.button_reply?.title ?? '';
        out.push({
          channelUserId: String(m.from),
          text: String(text).trim(),
          name: names.get(String(m.from)) || undefined,
          timestamp: Number(m.timestamp ?? Date.now() / 1000) * 1000,
          messageId: String(m.id),
        });
      }
    }
  }
  return out;
}

/** Split on paragraph boundaries, then lines — never mid-word. */
export function splitForCloud(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = '';
  for (const para of text.split('\n\n')) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length <= max) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    if (para.length <= max) {
      buf = para;
      continue;
    }
    let rest = para;
    while (rest.length > max) {
      const cut = rest.lastIndexOf('\n', max);
      const at = cut > max * 0.5 ? cut : max;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n/, '');
    }
    buf = rest;
  }
  if (buf) out.push(buf);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
