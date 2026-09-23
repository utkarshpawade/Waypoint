import { defineConfig } from 'vitest/config';

/**
 * Run the suite on a UTC clock, like Render. Every local machine this was
 * built on was in IST, which hid a bug where departure times were read in the
 * server's zone: "morning flights" returned afternoon ones in production only.
 * Set here so the test workers inherit it before any date code loads.
 */
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    /**
     * The suite must never touch the network or a real database, even on a
     * machine with a populated .env — otherwise it becomes slow, flaky, and
     * dependent on someone's free-tier quota. Blanking these forces the
     * in-memory store and the rules engine, which is also the configuration
     * the resilience story claims to survive.
     */
    env: {
      TZ: 'UTC',
      LLM_API_KEY: '',
      BREVO_API_KEY: '',
      RAPIDAPI_KEY: '',
      FLIGHT_PROVIDER: 'mock',
      DATABASE_URL: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      OWNER_WHATSAPP: '',
      ALLOWED_SENDERS: '',
      WA_CLOUD_TOKEN: '',
      WA_CLOUD_PHONE_NUMBER_ID: '',
      WA_CLOUD_VERIFY_TOKEN: 'waypoint-verify',
      WA_CLOUD_APP_SECRET: '',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      BUSINESS_TZ: 'Asia/Kolkata',
      BUSINESS_HOURS: '09:00-22:00',
      LOG_LEVEL: 'silent',
      PRETTY_LOGS: 'false',
    },
  },
});
