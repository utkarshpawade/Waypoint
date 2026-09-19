import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!config.hasDb) throw new Error('DATABASE_URL is not set — no Postgres pool available');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      // Neon requires TLS; its certs are public CAs but Render's Node images
      // occasionally lack the intermediate, so don't hard-fail on chain checks.
      ssl: config.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
