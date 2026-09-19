import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Return DATE columns as the plain 'YYYY-MM-DD' string they are.
 *
 * By default node-postgres turns a DATE into a JS Date at *local* midnight.
 * Anything that then formats it via toISOString() shifts it backwards by the
 * UTC offset — so a passenger born on 12/04/1992 comes back out of the database
 * as 1992-04-11 in Asia/Kolkata. A date of birth that no longer matches the
 * passport is a booking that fails at the airport, so dates never become
 * timestamps here.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!config.hasDb) throw new Error('DATABASE_URL is not set — no Postgres pool available');
  if (!pool) {
    const local = config.DATABASE_URL.includes('localhost');
    pool = new pg.Pool({
      // We set `ssl` explicitly below, so strip the URL's sslmode and
      // channel_binding parameters: pg-connection-string would otherwise log a
      // deprecation warning on every boot, and Render's log stream is the only
      // production debugger this has.
      connectionString: config.DATABASE_URL.replace(/[?&](sslmode|channel_binding)=[^&]*/g, (m) =>
        m.startsWith('?') ? '?' : '',
      ).replace(/\?&/, '?').replace(/[?&]$/, ''),
      // Neon requires TLS; its certs are from public CAs but Render's Node
      // images occasionally lack the intermediate, so don't hard-fail on chain
      // checks — the connection is still encrypted.
      ssl: local ? undefined : { rejectUnauthorized: false },
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
