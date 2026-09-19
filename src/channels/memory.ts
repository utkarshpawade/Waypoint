import type { Channel, InboundMessage, MessageHandler } from './types.js';

/**
 * Test double. Because nothing downstream imports Baileys, the whole
 * conversation engine can be driven end-to-end through this.
 */
export class MemoryChannel implements Channel {
  readonly name = 'memory' as const;
  private handler: MessageHandler | null = null;
  /** Everything the bot sent, in order: [to, text]. */
  readonly sent: { to: string; text: string }[] = [];
  private seq = 0;
  /**
   * Message ids are unique per instance. Against a persistent store the
   * idempotency guard would otherwise treat a second run's "mem-1" as a replay
   * of the first run's and silently drop it.
   */
  private readonly runId = Math.random().toString(36).slice(2, 10);

  async start(): Promise<void> {}

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }

  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
  }

  /** Drive a user turn and wait for the bot to finish replying. */
  async userSays(text: string, from = 'test-user'): Promise<void> {
    const m: InboundMessage = {
      channelUserId: from,
      text,
      name: 'Test User',
      timestamp: Date.now(),
      messageId: `mem-${this.runId}-${++this.seq}`,
    };
    await this.handler?.(m);
  }

  /** Everything sent since the given index, joined — handy for assertions. */
  transcriptSince(index: number): string {
    return this.sent.slice(index).map((s) => s.text).join('\n---\n');
  }

  lastText(): string {
    return this.sent.at(-1)?.text ?? '';
  }

  status() {
    return { connected: true, state: 'open' };
  }

  async stop(): Promise<void> {}
}
