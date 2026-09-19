import { defineConfig } from 'vitest/config';

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
      LLM_API_KEY: '',
      DATABASE_URL: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      OWNER_WHATSAPP: '',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      BUSINESS_TZ: 'Asia/Kolkata',
      BUSINESS_HOURS: '09:00-22:00',
      LOG_LEVEL: 'silent',
      PRETTY_LOGS: 'false',
    },
  },
});
