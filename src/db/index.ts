import { config } from '../config.js';
import { logger } from '../logger.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './repositories.js';
import type { Store } from './types.js';

let store: Store | null = null;

/** Postgres when DATABASE_URL is set, in-memory otherwise. Chosen once, at boot. */
export function getStore(): Store {
  if (!store) {
    store = config.hasDb ? new PostgresStore() : new MemoryStore();
    if (!config.hasDb) {
      logger.warn('DATABASE_URL not set — using in-memory store. State will NOT survive a restart.');
    }
  }
  return store;
}

/** Tests inject their own store. */
export function setStore(s: Store): void {
  store = s;
}

export * from './types.js';
