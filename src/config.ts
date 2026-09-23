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
  /**
   * Brevo's HTTPS email API. Preferred over SMTP when set: Render's free tier
   * blocks outbound SMTP ports (25/465/587), so on Render SMTP simply times out.
   */
  BREVO_API_KEY: z.string().default(''),

  // Flights
  FLIGHT_PROVIDER: z.enum(['mock', 'amadeus', 'skyscanner']).default('mock'),
  AMADEUS_CLIENT_ID: z.string().default(''),
  AMADEUS_CLIENT_SECRET: z.string().default(''),
  /** RapidAPI key, subscribed to the Skyscanner ("Sky Scrapper") API. */
  RAPIDAPI_KEY: z.string().default(''),
  RAPIDAPI_SKYSCANNER_HOST: z.string().default('sky-scrapper.p.rapidapi.com'),

  // App
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  // 'cloud' = Meta's official WhatsApp Cloud API; 'whatsapp' = Baileys.
  CHANNEL: z.enum(['whatsapp', 'cloud', 'cli', 'memory']).default('whatsapp'),

  // WhatsApp Cloud API (CHANNEL=cloud)
  WA_CLOUD_TOKEN: z.string().default(''),
  WA_CLOUD_PHONE_NUMBER_ID: z.string().default(''),
  WA_CLOUD_VERIFY_TOKEN: z.string().default('waypoint-verify'),
  WA_CLOUD_APP_SECRET: z.string().default(''),
  ADMIN_TOKEN: z.string().min(8).default('waypoint-dev-admin-token'),
  OWNER_WHATSAPP: z.string().default(''),
  WA_PAIRING_NUMBER: z.string().default(''),
  /**
   * Comma-separated numbers the bot will answer. Empty = answer everyone.
   * Set it when the bot shares a number with a human: the interviewer gets a
   * cold, working bot while everyone else's messages pass straight through to
   * the person, untouched.
   */
  ALLOWED_SENDERS: z.string().default(''),
  ESCALATION_SLA_MINUTES: z.coerce.number().int().positive().default(10),
  /** The human a handed-off user hears from. Used in the email and the chat. */
  AGENT_NAME: z.string().default('Utkarsh'),
  AGENT_TITLE: z.string().default('Customer Care, Waypoint Travel'),
  BUSINESS_HOURS: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'BUSINESS_HOURS must look like 09:00-22:00')
    .default('09:00-22:00'),
  BUSINESS_TZ: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
  hasBrevo: env.BREVO_API_KEY.length > 0,
  hasCloudApi: env.WA_CLOUD_TOKEN.length > 0 && env.WA_CLOUD_PHONE_NUMBER_ID.length > 0,
  /** Digits only, so "+91 98765 43210" and "919876543210" are the same entry. */
  allowedSenders: env.ALLOWED_SENDERS.split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean),
} as const;

export type Config = typeof config;
