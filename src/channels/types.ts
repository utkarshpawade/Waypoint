export interface InboundMessage {
  /** Stable per-user id. For WhatsApp this is the bare JID ("9198…@s.whatsapp.net"). */
  channelUserId: string;
  text: string;
  name?: string;
  timestamp: number;
  /** Provider message id, used for idempotency across reconnect replays. */
  messageId?: string;
}

export type MessageHandler = (m: InboundMessage) => Promise<void>;

export interface Channel {
  name: 'whatsapp' | 'cli' | 'memory';
  start(): Promise<void>;
  onMessage(h: MessageHandler): void;
  send(to: string, text: string): Promise<void>;
  sendTyping?(to: string): Promise<void>;
  stop(): Promise<void>;
  /** Coarse connection state, surfaced by /health. */
  status(): { connected: boolean; state: string; jid?: string; since?: number; lastError?: string };
}
