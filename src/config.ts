import 'dotenv/config';
import { z } from 'zod';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  // LLM
  LLM_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  LLM_MODEL: z.string().default('gemini-2.5-flash'),
  LLM_API_KEY: z.string().default(''),

  // Database
  DATABASE_URL: z.string().default(''),

  // Email
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('Waypoint Travel <no-reply@waypoint.local>'),

  // Flights
  FLIGHT_PROVIDER: z.enum(['mock', 'amadeus']).default('mock'),
  AMADEUS_CLIENT_ID: z.string().default(''),
  AMADEUS_CLIENT_SECRET: z.string().default(''),

  // App
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  CHANNEL: z.enum(['whatsapp', 'cli', 'memory']).default('whatsapp'),
  ADMIN_TOKEN: z.string().min(8).default('waypoint-dev-admin-token'),
  OWNER_WHATSAPP: z.string().default(''),
  WA_PAIRING_NUMBER: z.string().default(''),
  ESCALATION_SLA_MINUTES: z.coerce.number().int().positive().default(10),
  BUSINESS_HOURS: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'BUSINESS_HOURS must look like 09:00-22:00')
    .default('09:00-22:00'),
  BUSINESS_TZ: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PRETTY_LOGS: bool(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly and readably — a bad env var at 11pm on Render should be obvious in one line.
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n✖ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

const [openAt, closeAt] = env.BUSINESS_HOURS.split('-');

export const config = {
  ...env,
  businessHours: { open: openAt, close: closeAt },
  /** Base URL with any trailing slash removed, so `${base}/pay/X` is always well-formed. */
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
  hasLlm: env.LLM_API_KEY.length > 0,
  hasDb: env.DATABASE_URL.length > 0,
  hasSmtp: env.SMTP_HOST.length > 0 && env.SMTP_USER.length > 0 && env.SMTP_PASS.length > 0,
} as const;

export type Config = typeof config;
