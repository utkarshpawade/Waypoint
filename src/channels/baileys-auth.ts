import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { getPool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Baileys auth state backed by Postgres.
 *
 * Render's free tier has no persistent disk, so `useMultiFileAuthState` would
 * lose the WhatsApp session on every restart, redeploy and sleep cycle — the bot
 * would demand a fresh pairing each time. Keeping creds in Neon means a restart
 * reconnects silently.
 *
 * The one thing that must not be got wrong: credentials contain Buffers, and
 * plain JSON.stringify silently mangles them into `{type:'Buffer',data:[...]}`
 * shapes Baileys cannot read back. Every write goes through BufferJSON.replacer
 * and every read through BufferJSON.reviver.
 */

const TABLE = 'wa_auth';

async function readRow(id: string): Promise<any | null> {
  const { rows } = await getPool().query(`SELECT data FROM ${TABLE} WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  // pg parses jsonb into a JS object, so re-serialise before reviving Buffers.
  return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
}

async function readMany(ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await getPool().query(`SELECT id, data FROM ${TABLE} WHERE id = ANY($1::text[])`, [ids]);
  for (const r of rows) {
    out.set(r.id, JSON.parse(JSON.stringify(r.data), BufferJSON.reviver));
  }
  return out;
}

async function writeRow(id: string, value: unknown): Promise<void> {
  const serialised = JSON.stringify(value, BufferJSON.replacer);
  await getPool().query(
    `INSERT INTO ${TABLE} (id, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, serialised],
  );
}

async function deleteRows(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await getPool().query(`DELETE FROM ${TABLE} WHERE id = ANY($1::text[])`, [ids]);
}

/** Wipe the stored session. Called on DisconnectReason.loggedOut, or nothing ever re-pairs. */
export async function clearPostgresAuthState(): Promise<void> {
  await getPool().query(`DELETE FROM ${TABLE}`);
  logger.warn('wa_auth cleared — a fresh pairing is required');
}

export async function usePostgresAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
}> {
  const stored = await readRow('creds');
  const creds: AuthenticationCreds = stored ?? initAuthCreds();

  if (stored) logger.info('wa_auth: restored credentials from Postgres');
  else logger.info('wa_auth: no stored credentials — pairing required');

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const rowIds = ids.map((id) => `${type}-${id}`);
        const found = await readMany(rowIds);
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = found.get(`${type}-${id}`);
          if (value !== undefined && value !== null) {
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }
        }
        return result;
      },
      set: async (data) => {
        const writes: Promise<void>[] = [];
        const deletes: string[] = [];
        for (const category of Object.keys(data)) {
          const entries = (data as any)[category] ?? {};
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            const rowId = `${category}-${id}`;
            if (value === null || value === undefined) deletes.push(rowId);
            else writes.push(writeRow(rowId, value));
          }
        }
        await Promise.all([...writes, deleteRows(deletes)]);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await writeRow('creds', creds);
    },
    clear: clearPostgresAuthState,
  };
}
