/**
 * Server-sent events fan-out for the agent console. Lives on its own so the
 * escalation service can push without importing the router (and creating a
 * cycle), and so the console has exactly one subscriber list.
 */
export interface SseClient {
  write: (frame: string) => void;
}

const clients = new Set<SseClient>();

export function addSseClient(c: SseClient): void {
  clients.add(c);
}

export function removeSseClient(c: SseClient): void {
  clients.delete(c);
}

export function pushConsoleEvent(type: string, payload: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients]) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

export function sseClientCount(): number {
  return clients.size;
}
