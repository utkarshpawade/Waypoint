import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'email' });

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** True when SMTP is not configured and the message was only logged. */
  simulated?: boolean;
}

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

export async function verifyEmail(): Promise<{ ok: boolean; error?: string }> {
  const t = getTransport();
  if (!t) return { ok: false, error: 'SMTP is not configured' };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Two retries, then an honest failure. The caller must never tell the user an
 * email was sent when it wasn't — a PROVIDER_FAILURE escalation is the correct
 * outcome, not a cheerful "check your inbox".
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const t = getTransport();
  if (!t) {
    log.warn({ to: opts.to, subject: opts.subject }, 'SMTP not configured — email not sent (simulated)');
    return { ok: false, simulated: true, error: 'SMTP not configured' };
  }

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const info = await t.sendMail({
        from: config.MAIL_FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      log.info({ to: opts.to, messageId: info.messageId, attempt }, 'email sent');
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      lastError = (err as Error).message;
      log.warn({ err: lastError, attempt }, 'email send failed');
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { ok: false, error: lastError };
}
