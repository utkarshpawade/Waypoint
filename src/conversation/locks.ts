/**
 * One turn at a time per conversation.
 *
 * WhatsApp delivers bursts ("delhi" / "to goa" / "tomorrow") as separate
 * events, and each turn is load-session → think → save-session. Run two of
 * those concurrently and the second save silently erases the first turn's
 * slots. The SLA sweeper edits sessions too, so it queues here as well.
 */
const tails = new Map<string, Promise<void>>();

export function withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

export function conversationKey(channel: string, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}
