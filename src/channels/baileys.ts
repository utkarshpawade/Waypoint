import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WASocket, AuthenticationState } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import { config } from '../config.js';
import { logger, maskId } from '../logger.js';
import { clearPostgresAuthState, usePostgresAuthState } from './baileys-auth.js';
import type { Channel, InboundMessage, MessageHandler } from './types.js';

const log = logger.child({ mod: 'baileys' });

/** Baileys wants its own pino instance; keep it quiet, ours does the reporting. */
const waLogger = pino({ level: 'warn' }) as any;

const MAX_CHARS = 3500;
const PER_CHAT_GAP_MS = 800;
const SEND_TIMEOUT_MS = 30_000;

type ConnState = 'closed' | 'connecting' | 'open';

export class BaileysChannel implements Channel {
  readonly name = 'whatsapp' as const;

  private sock: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private connState: ConnState = 'closed';
  private since = 0;
  private lastError: string | undefined;
  private latestQr: string | null = null;
  private saveCreds: () => Promise<void> = async () => {};
  private clearAuth: () => Promise<void> = async () => {};
  private registered = false;
  private stopping = false;
  private backoffMs = 1000;
  private seenIds = new Set<string>();
  private sendChain: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.connect();
  }

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }

  status() {
    return {
      connected: this.connState === 'open',
      state: this.connState,
      jid: this.sock?.user?.id,
      since: this.since || undefined,
      lastError: this.lastError,
    };
  }

  /** The QR string from the most recent connection.update, for /admin/qr. */
  currentQr(): string | null {
    return this.latestQr;
  }

  async requestPairingCode(phone: string): Promise<string> {
    if (!this.sock) throw new Error('socket not started');
    if (this.registered) throw new Error('already paired — clear wa_auth first if you want to re-pair');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) throw new Error('phone must be in international format, e.g. 919876543210');
    const code = await this.sock.requestPairingCode(digits);
    log.info({ phone: maskId(digits) }, 'pairing code issued');
    return code.match(/.{1,4}/g)?.join('-') ?? code;
  }

  async logoutAndClear(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      /* socket may already be gone */
    }
    await this.clearAuth();
    this.registered = false;
  }

  private async loadAuth(): Promise<AuthenticationState> {
    if (config.hasDb) {
      const { state, saveCreds, clear } = await usePostgresAuthState();
      this.saveCreds = saveCreds;
      this.clearAuth = clear;
      this.registered = Boolean(state.creds.registered);
      return state;
    }
    // Local-only fallback: no Postgres, so persist to disk. Never used on Render.
    log.warn('no DATABASE_URL — falling back to file-based auth (auth_info_baileys/)');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    this.saveCreds = saveCreds;
    this.clearAuth = async () => {};
    this.registered = Boolean(state.creds.registered);
    return state;
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const state = await this.loadAuth();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));

    this.connState = 'connecting';
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      logger: waLogger,
      printQRInTerminal: false,
      browser: ['Waypoint', 'Chrome', '1.0.0'],
      // Do NOT mark online: it would hijack the phone's presence and suppress
      // the owner's own WhatsApp notifications.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    this.sock.ev.on('creds.update', () => {
      this.saveCreds().catch((err) => log.error({ err }, 'failed to persist creds'));
    });

    this.sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr, isNewLogin } = u;
      if (qr) {
        this.latestQr = qr;
        log.info('QR refreshed — GET /admin/qr?token=… to scan, or use /admin/pair');
      }
      if (isNewLogin) this.registered = true;

      if (connection === 'open') {
        this.connState = 'open';
        this.since = Date.now();
        this.backoffMs = 1000;
        this.latestQr = null;
        this.registered = true;
        this.lastError = undefined;
        log.info({ jid: this.sock?.user?.id }, 'whatsapp connected');
      } else if (connection === 'connecting') {
        this.connState = 'connecting';
        log.info('whatsapp connecting');
      } else if (connection === 'close') {
        this.connState = 'closed';
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        this.lastError = `${statusCode ?? 'unknown'}: ${lastDisconnect?.error?.message ?? ''}`.trim();
        log.warn({ statusCode, err: lastDisconnect?.error?.message }, 'whatsapp disconnected');

        if (statusCode === DisconnectReason.loggedOut) {
          // Reconnecting with dead creds loops forever — wipe and demand a re-pair.
          log.error('logged out — clearing stored auth, re-pair required');
          void (config.hasDb ? clearPostgresAuthState() : Promise.resolve()).finally(() => {
            this.registered = false;
            this.scheduleReconnect();
          });
        } else {
          this.scheduleReconnect();
        }
      }
    });

    this.sock.ev.on('messages.upsert', (ev) => {
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages) void this.handleInbound(msg);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 400);
    const delay = Math.min(this.backoffMs, 30_000) + jitter;
    log.info({ delay }, 'scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.connect().catch((err) => {
        log.error({ err }, 'reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async handleInbound(msg: any): Promise<void> {
    try {
      const jid: string = msg.key?.remoteJid ?? '';
      if (!jid || msg.key?.fromMe) return;
      if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

      const id: string = msg.key?.id ?? '';
      if (id) {
        if (this.seenIds.has(id)) return; // reconnects replay messages
        this.seenIds.add(id);
        if (this.seenIds.size > 2000) {
          this.seenIds = new Set([...this.seenIds].slice(-1000));
        }
      }

      const m = msg.message;
      // People reply-quote constantly and only extendedTextMessage is populated then.
      const text: string =
        m?.conversation ??
        m?.extendedTextMessage?.text ??
        m?.imageMessage?.caption ??
        m?.videoMessage?.caption ??
        '';

      if (!text.trim()) {
        if (m && !m.protocolMessage && !m.reactionMessage && !m.senderKeyDistributionMessage) {
          await this.send(jid, 'I can only read text right now — could you type that out for me?');
        }
        return;
      }

      const inbound: InboundMessage = {
        channelUserId: jid,
        text: text.trim(),
        name: msg.pushName ?? undefined,
        timestamp: Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000,
        messageId: id || undefined,
      };
      log.info({ from: maskId(jid), len: text.length }, 'inbound');
      await this.handler?.(inbound);
    } catch (err) {
      log.error({ err }, 'inbound handler threw');
    }
  }

  async sendTyping(to: string): Promise<void> {
    try {
      await this.sock?.presenceSubscribe(to);
      await this.sock?.sendPresenceUpdate('composing', to);
    } catch {
      /* presence is best-effort */
    }
  }

  /**
   * Outbound is serialised with a gap between messages: rapid-fire sending is
   * the single biggest ban trigger on an unofficial client.
   */
  async send(to: string, text: string): Promise<void> {
    const chunks = splitMessage(text, MAX_CHARS);
    this.sendChain = this.sendChain.then(async () => {
      for (const chunk of chunks) {
        try {
          // Every step is bounded. This chain is shared by every chat, so one
          // send that never settles (a socket that died mid-reconnect) would
          // otherwise silence the bot for everyone until the next restart.
          await withTimeout(this.sendTyping(to), 5_000, 'typing');
          await sleep(humanDelay(chunk.length));
          await withTimeout(this.sock?.sendMessage(to, { text: chunk }), SEND_TIMEOUT_MS, 'sendMessage');
          await withTimeout(this.sock?.sendPresenceUpdate('paused', to), 5_000, 'presence');
          log.info({ to: maskId(to), len: chunk.length }, 'outbound');
        } catch (err) {
          log.error({ err, to: maskId(to) }, 'send failed');
        }
        await sleep(PER_CHAT_GAP_MS);
      }
    });
    return this.sendChain;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T> | undefined, ms: number, what: string): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 600–1200ms scaled to length: feels human, and throttles us. */
function humanDelay(len: number): number {
  return Math.min(1200, 600 + len * 1.2);
}

/** Split on paragraph boundaries first, then lines, never mid-word. */
export function splitMessage(text: string, max = MAX_CHARS): string[] {
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
