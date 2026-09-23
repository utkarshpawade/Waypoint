import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'email' });

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** True when no email transport is configured and the message was only logged. */
  simulated?: boolean;
}

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Two transports, one contract. Brevo's HTTPS API is preferred when its key is
 * set, because Render's free tier blocks outbound SMTP ports — there, SMTP
 * doesn't fail loudly, it just times out and every handoff email is lost.
 * Plain SMTP remains for local runs and paid hosts.
 */
let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!config.hasSmtp) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
    });
  }
  return transporter;
}

/** "Waypoint Travel <you@gmail.com>" → { name, email }. */
export function parseFrom(from: string): { name?: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
  return { email: from.trim() };
}

async function sendViaBrevo(mail: Mail): Promise<{ messageId?: string }> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: parseFrom(config.MAIL_FROM),
      to: [{ email: mail.to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string };
  // A 400 here is usually an unverified sender: MAIL_FROM must be a sender
  // address verified in Brevo (Senders & IP → Senders).
  if (!res.ok) throw new Error(`brevo HTTP ${res.status}: ${body.message ?? 'unknown error'}`);
  return { messageId: body.messageId };
}

async function sendViaSmtp(t: Transporter, mail: Mail): Promise<{ messageId?: string }> {
  const info = await t.sendMail({ from: config.MAIL_FROM, ...mail });
  return { messageId: info.messageId };
}

export async function verifyEmail(): Promise<{ ok: boolean; error?: string; via?: 'brevo' | 'smtp' }> {
  if (config.hasBrevo) {
    try {
      const res = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': config.BREVO_API_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { ok: true, via: 'brevo' } : { ok: false, via: 'brevo', error: `Brevo rejected the key (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, via: 'brevo', error: (err as Error).message };
    }
  }
  const t = getTransport();
  if (!t) return { ok: false, error: 'no email transport is configured (set BREVO_API_KEY or SMTP_*)' };
  try {
    await t.verify();
    return { ok: true, via: 'smtp' };
  } catch (err) {
    return { ok: false, via: 'smtp', error: (err as Error).message };
  }
}

/**
 * Two retries, then an honest failure. The caller must never tell the user an
 * email was sent when it wasn't — a PROVIDER_FAILURE escalation is the correct
 * outcome, not a cheerful "check your inbox".
 */
export async function sendMail(mail: Mail): Promise<SendResult> {
  const smtp = config.hasBrevo ? null : getTransport();
  if (!config.hasBrevo && !smtp) {
    log.warn({ to: mail.to, subject: mail.subject }, 'no email transport configured — email not sent (simulated)');
    return { ok: false, simulated: true, error: 'email not configured' };
  }
  const via = config.hasBrevo ? 'brevo' : 'smtp';

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { messageId } = smtp ? await sendViaSmtp(smtp, mail) : await sendViaBrevo(mail);
      log.info({ to: mail.to, messageId, attempt, via }, 'email sent');
      return { ok: true, messageId };
    } catch (err) {
      lastError = (err as Error).message;
      log.warn({ err: lastError, attempt, via }, 'email send failed');
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { ok: false, error: lastError };
}
