import readline from 'node:readline';
import type { Channel, MessageHandler } from './types.js';

/**
 * Terminal channel — identical code path to WhatsApp, so "works locally /
 * breaks deployed" cannot happen. `npm run cli`.
 */
export class CliChannel implements Channel {
  readonly name = 'cli' as const;
  private handler: MessageHandler | null = null;
  private rl: readline.Interface | null = null;
  private readonly userId = 'cli-user';
  private seq = 0;

  async start(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you ▸ ' });
    console.log('\nWaypoint CLI — type a message, Ctrl+C to quit.\n');
    this.rl.prompt();
    this.rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return this.rl?.prompt();
      try {
        await this.handler?.({
          channelUserId: this.userId,
          text,
          name: 'CLI User',
          timestamp: Date.now(),
          messageId: `cli-${++this.seq}`,
        });
      } catch (err) {
        console.error('handler error:', err);
      }
      this.rl?.prompt();
    });
    this.rl.on('close', () => process.exit(0));
  }

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }

  async send(_to: string, text: string): Promise<void> {
    // Render WhatsApp markup readably in a terminal.
    const pretty = text.replace(/\*(.+?)\*/g, '[1m$1[0m').replace(/_(.+?)_/g, '[3m$1[0m');
    console.log(`\nbot ▸ ${pretty.split('\n').join('\n      ')}\n`);
  }

  async sendTyping(): Promise<void> {}

  status() {
    return { connected: true, state: 'open' };
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
