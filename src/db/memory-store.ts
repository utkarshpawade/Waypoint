import type {
  BookingRecord,
  EscalationRecord,
  EscalationStatus,
  EventRecord,
  MessageRecord,
  PassengerRecord,
  SessionRecord,
  Store,
} from './types.js';

/**
 * In-process store used when DATABASE_URL is unset — `npm run cli`, tests, and
 * a first run before Neon exists. Same interface as PostgresStore, so nothing
 * downstream knows the difference; state simply does not survive a restart,
 * which is exactly why production uses Postgres (see PLAN §2.3).
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private sessions = new Map<string, SessionRecord>();
  private messages: MessageRecord[] = [];
  private seenMsgIds = new Set<string>();
  private bookings = new Map<string, BookingRecord>();
  private passengers: PassengerRecord[] = [];
  private escalations = new Map<string, EscalationRecord>();
  private events: EventRecord[] = [];
  private msgSeq = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async rawQuery<T = Record<string, unknown>>(): Promise<T[]> {
    return [];
  }

  async getSessionByChannelUser(channel: string, channelUserId: string): Promise<SessionRecord | null> {
    for (const s of this.sessions.values()) {
      if (s.channel === channel && s.channelUserId === channelUserId) return structuredClone(s);
    }
    return null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async createSession(s: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord> {
    const rec: SessionRecord = { ...structuredClone(s), createdAt: new Date(), updatedAt: new Date() };
    this.sessions.set(rec.id, rec);
    return structuredClone(rec);
  }

  async saveSession(s: SessionRecord): Promise<void> {
    this.sessions.set(s.id, { ...structuredClone(s), updatedAt: new Date() });
  }

  async insertMessage(m: MessageRecord): Promise<boolean> {
    if (m.waMsgId) {
      if (this.seenMsgIds.has(m.waMsgId)) return false;
      this.seenMsgIds.add(m.waMsgId);
    }
    this.messages.push({ ...m, id: this.msgSeq++, createdAt: new Date() });
    return true;
  }

  async recentMessages(sessionId: string, limit: number): Promise<MessageRecord[]> {
    return this.messages.filter((m) => m.sessionId === sessionId).slice(-limit).map((m) => ({ ...m }));
  }

  async createBooking(b: Omit<BookingRecord, 'createdAt'>): Promise<BookingRecord> {
    const rec: BookingRecord = { ...structuredClone(b), createdAt: new Date() };
    this.bookings.set(rec.ref, rec);
    return structuredClone(rec);
  }

  async getBooking(ref: string): Promise<BookingRecord | null> {
    const b = this.bookings.get(ref);
    return b ? structuredClone(b) : null;
  }

  async updateBooking(ref: string, patch: Partial<BookingRecord>): Promise<void> {
    const b = this.bookings.get(ref);
    if (b) this.bookings.set(ref, { ...b, ...patch });
  }

  async insertPassengers(rows: PassengerRecord[]): Promise<void> {
    this.passengers.push(...structuredClone(rows));
  }

  async listPassengers(bookingRef: string): Promise<PassengerRecord[]> {
    return this.passengers.filter((p) => p.bookingRef === bookingRef).sort((a, b) => a.seq - b.seq);
  }

  async createEscalation(
    e: Omit<EscalationRecord, 'createdAt' | 'claimedAt' | 'resolvedAt'>,
  ): Promise<EscalationRecord> {
    const rec: EscalationRecord = {
      ...structuredClone(e),
      createdAt: new Date(),
      claimedAt: null,
      resolvedAt: null,
      slaNotifiedAt: null,
    };
    this.escalations.set(rec.ticket, rec);
    return structuredClone(rec);
  }

  async getEscalation(ticket: string): Promise<EscalationRecord | null> {
    const e = this.escalations.get(ticket);
    return e ? structuredClone(e) : null;
  }

  async listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]> {
    return [...this.escalations.values()]
      .filter((e) => !status || e.status === status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((e) => structuredClone(e));
  }

  async updateEscalation(ticket: string, patch: Partial<EscalationRecord>): Promise<void> {
    const e = this.escalations.get(ticket);
    if (e) this.escalations.set(ticket, { ...e, ...patch });
  }

  async findOpenEscalationBySession(sessionId: string): Promise<EscalationRecord | null> {
    const open = [...this.escalations.values()]
      .filter((e) => e.sessionId === sessionId && e.status !== 'RESOLVED')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ? structuredClone(open[0]) : null;
  }

  async insertEvent(e: EventRecord): Promise<void> {
    this.events.push({ ...e, createdAt: new Date() });
  }

  async countEvents(type: string): Promise<number> {
    return this.events.filter((e) => e.type === type).length;
  }

  /** Test/metrics helper — not part of the Store interface. */
  allEvents(): EventRecord[] {
    return this.events.map((e) => ({ ...e }));
  }
}
