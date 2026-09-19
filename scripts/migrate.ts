import { config } from '../src/config.js';
import { PostgresStore } from '../src/db/repositories.js';

if (!config.hasDb) {
  console.error('✖ DATABASE_URL is not set. Put your Neon connection string in .env first.');
  process.exit(1);
}

const store = new PostgresStore();
try {
  await store.init();
  const tables = await store.rawQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('✔ Schema applied. Tables:');
  for (const t of tables) console.log(`   • ${t.table_name}`);
} catch (err) {
  console.error('✖ Migration failed:', err);
  process.exitCode = 1;
} finally {
  await store.close();
}
