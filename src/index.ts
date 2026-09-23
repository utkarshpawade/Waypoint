import { config } from './config.js';
import { logger } from './logger.js';
import { getStore } from './db/index.js';
import { setActiveChannel } from './channels/registry.js';
import { BaileysChannel } from './channels/baileys.js';
import { CloudApiChannel } from './channels/cloud-api.js';
import { CliChannel } from './channels/cli.js';
import { MemoryChannel } from './channels/memory.js';
import { handleTurn } from './conversation/engine.js';
import { startSlaSweeper, stopSlaSweeper } from './escalation/service.js';
import { startServer } from './web/server.js';
import { llm } from './llm/client.js';
import type { Channel } from './channels/types.js';

const log = logger.child({ mod: 'boot' });

function makeChannel(): Channel {
  switch (config.CHANNEL) {
    case 'cloud':
      return new CloudApiChannel();
    case 'cli':
      return new CliChannel();
    case 'memory':
      return new MemoryChannel();
    default:
      return new BaileysChannel();
  }
}

async function main(): Promise<void> {
  log.info(
    { channel: config.CHANNEL, model: config.hasLlm ? config.LLM_MODEL : 'rules-only', db: config.hasDb ? 'postgres' : 'memory' },
    'starting waypoint',
  );

  const store = getStore();
  await store.init();

  const server = await startServer();

  const channel = makeChannel();
  setActiveChannel(channel);
  channel.onMessage((m) => handleTurn(m, channel));
  await channel.start();

  startSlaSweeper();

  void llm.probe().then((r) => {
    if (r.ok) log.info({ model: config.LLM_MODEL }, 'llm key verified');
    else if (config.hasLlm) log.error({ err: r.error }, 'LLM KEY REJECTED — the bot is running on rules only until this is fixed');
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopSlaSweeper();
    await channel.stop().catch(() => {});
    server.close();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});
