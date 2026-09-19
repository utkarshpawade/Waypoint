import pino from 'pino';
import { config } from './config.js';

/**
 * Render's log viewer is the only production debugger, so logs are structured
 * and PII-redacted rather than pretty-printed strings.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'passport_no',
      'passportNo',
      'passportNumber',
      '*.passport_no',
      '*.passportNo',
      '*.passportNumber',
      'email',
      '*.email',
      'phone',
      '*.phone',
      'dob',
      '*.dob',
      'dateOfBirth',
      '*.dateOfBirth',
      'SMTP_PASS',
      'LLM_API_KEY',
      'DATABASE_URL',
      'creds',
    ],
    censor: '[redacted]',
  },
  ...(config.PRETTY_LOGS
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/** Masks a phone number / JID for logs: 919876543210 → +9198•••••210 */
export function maskId(id: string): string {
  const digits = id.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  return `+${digits.slice(0, 4)}${'•'.repeat(Math.max(0, digits.length - 7))}${digits.slice(-3)}`;
}
