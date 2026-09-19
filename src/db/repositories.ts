import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './pool.js';
import { logger } from '../logger.js';
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

const here = dirname(fileURLToPath(import.meta.url));

function rowToSession(r: any): SessionRecord {
  return {
    id: r.id,
    channel: r.channel,
    channelUserId: r.channel_user_id,
    displayName: r.display_name,
    state: r.state,
    slots: r.slots ?? {},
    offers: r.offers ?? null,
    selectedOfferId: r.selected_offer_id,
    control: r.control,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToBooking(r: any): BookingRecord {
  return {
    ref: r.ref,
    sessionId: r.session_id,
    offer: r.offer,
    total: r.total,
    currency: r.currency,
    status: r.status,
    paymentLink: r.payment_link,
    emailTo: r.email_to,
    emailedAt: r.emailed_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

function rowToEscalation(r: any): EscalationRecord {
  return {
    ticket: r.ticket,
    sessionId: r.session_id,
    reason: r.reason,
    confidence: r.confidence,
    brief: r.brief,
    status: r.status,
    claimedBy: r.claimed_by,
    resolution: r.resolution,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    resolvedAt: r.resolved_at,
    slaNotifiedAt: r.sla_notified_at ?? null,
  };
}

function toDateOnly(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;

  async init(): Promise<void> {
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await getPool().query(sql);
    logger.info('schema applied');
  }

  async close(): Promise<void> {
    await closePool();
  }

  async rawQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await getPool().query(sql, params as any[]);
    return res.rows as T[];
  }

  // -- sessions ---------------------------------------------------------------
  async getSessionByChannelUser(channel: string, channelUserId: string): Promise<SessionRecord | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM sessions WHERE channel = $1 AND channel_user_id = $2',
      [channel, channelUserId],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await getPool().query('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async createSession(s: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord> {
    const { rows } = await getPool().query(
      `INSERT INTO sessions (id, channel, channel_user_id, display_name, state, slots, offers, selected_offer_id, control)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (channel_user_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [
        s.id,
        s.channel,
        s.channelUserId,
        s.displayName,
        s.state,
        JSON.stringify(s.slots),
        s.offers ? JSON.stringify(s.offers) : null,
        s.selectedOfferId,
        s.control,
      ],
    );
    return rowToSession(rows[0]);
  }

  async saveSession(s: SessionRecord): Promise<void> {
    await getPool().query(
      `UPDATE sessions SET display_name=$2, state=$3, slots=$4, offers=$5, selected_offer_id=$6,
              control=$7, updated_at=now() WHERE id=$1`,
      [
        s.id,
        s.displayName,
        s.state,
        JSON.stringify(s.slots),
        s.offers ? JSON.stringify(s.offers) : null,
        s.selectedOfferId,
        s.control,
      ],
    );
  }

  // -- messages ---------------------------------------------------------------
  async insertMessage(m: MessageRecord): Promise<boolean> {
    const { rows } = await getPool().query(
      `INSERT INTO messages (session_id, wa_msg_id, direction, author, body, confidence, intent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (wa_msg_id) DO NOTHING
       RETURNING id`,
      [m.sessionId, m.waMsgId ?? null, m.direction, m.author, m.body, m.confidence ?? null, m.intent ?? null],
    );
    return rows.length > 0;
  }

  async recentMessages(sessionId: string, limit: number): Promise<MessageRecord[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2',
      [sessionId, limit],
    );
    return rows
      .map((r: any) => ({
        id: r.id,
        sessionId: r.session_id,
        waMsgId: r.wa_msg_id,
        direction: r.direction,
        author: r.author,
        body: r.body,
        confidence: r.confidence,
        intent: r.intent,
        createdAt: r.created_at,
      }))
      .reverse();
  }

  // -- bookings ---------------------------------------------------------------
  async createBooking(b: Omit<BookingRecord, 'createdAt'>): Promise<BookingRecord> {
    const { rows } = await getPool().query(
      `INSERT INTO bookings (ref, session_id, offer, total, currency, status, payment_link, email_to, emailed_at, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        b.ref,
        b.sessionId,
        JSON.stringify(b.offer),
        b.total,
        b.currency,
        b.status,
        b.paymentLink,
        b.emailTo,
        b.emailedAt,
        b.paidAt,
      ],
    );
    return rowToBooking(rows[0]);
  }

  async getBooking(ref: string): Promise<BookingRecord | null> {
    const { rows } = await getPool().query('SELECT * FROM bookings WHERE ref = $1', [ref]);
    return rows[0] ? rowToBooking(rows[0]) : null;
  }

  async updateBooking(ref: string, patch: Partial<BookingRecord>): Promise<void> {
    const map: Record<string, string> = {
      status: 'status',
      paymentLink: 'payment_link',
      emailTo: 'email_to',
      emailedAt: 'emailed_at',
      paidAt: 'paid_at',
      total: 'total',
    };
    const sets: string[] = [];
    const vals: unknown[] = [ref];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        vals.push((patch as any)[k]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (!sets.length) return;
    await getPool().query(`UPDATE bookings SET ${sets.join(', ')} WHERE ref = $1`, vals as any[]);
  }

  // -- passengers -------------------------------------------------------------
  async insertPassengers(rows: PassengerRecord[]): Promise<void> {
    for (const p of rows) {
      await getPool().query(
        `INSERT INTO passengers (booking_ref, seq, full_name, dob, gender, email, phone, passport_no, passport_expiry, nationality)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          p.bookingRef,
          p.seq,
          p.fullName,
          p.dob,
          p.gender,
          p.email,
          p.phone,
          p.passportNo,
          p.passportExpiry,
          p.nationality,
        ],
      );
    }
  }

  async listPassengers(bookingRef: string): Promise<PassengerRecord[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM passengers WHERE booking_ref = $1 ORDER BY seq',
      [bookingRef],
    );
    return rows.map((r: any) => ({
      id: r.id,
      bookingRef: r.booking_ref,
      seq: r.seq,
      fullName: r.full_name,
      dob: toDateOnly(r.dob),
      gender: r.gender,
      email: r.email,
      phone: r.phone,
      passportNo: r.passport_no,
      passportExpiry: r.passport_expiry ? toDateOnly(r.passport_expiry) : null,
      nationality: r.nationality,
    }));
  }

  // -- escalations ------------------------------------------------------------
  async createEscalation(
    e: Omit<EscalationRecord, 'createdAt' | 'claimedAt' | 'resolvedAt'>,
  ): Promise<EscalationRecord> {
    const { rows } = await getPool().query(
      `INSERT INTO escalations (ticket, session_id, reason, confidence, brief, status, claimed_by, resolution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [e.ticket, e.sessionId, e.reason, e.confidence, JSON.stringify(e.brief), e.status, e.claimedBy, e.resolution],
    );
    return rowToEscalation(rows[0]);
  }

  async getEscalation(ticket: string): Promise<EscalationRecord | null> {
    const { rows } = await getPool().query('SELECT * FROM escalations WHERE ticket = $1', [ticket]);
    return rows[0] ? rowToEscalation(rows[0]) : null;
  }

  async listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]> {
    const { rows } = status
      ? await getPool().query('SELECT * FROM escalations WHERE status = $1 ORDER BY created_at DESC LIMIT 100', [
          status,
        ])
      : await getPool().query('SELECT * FROM escalations ORDER BY created_at DESC LIMIT 100');
    return rows.map(rowToEscalation);
  }

  async updateEscalation(ticket: string, patch: Partial<EscalationRecord>): Promise<void> {
    const map: Record<string, string> = {
      status: 'status',
      claimedBy: 'claimed_by',
      resolution: 'resolution',
      claimedAt: 'claimed_at',
      resolvedAt: 'resolved_at',
      slaNotifiedAt: 'sla_notified_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [ticket];
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        vals.push((patch as any)[k]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (!sets.length) return;
    await getPool().query(`UPDATE escalations SET ${sets.join(', ')} WHERE ticket = $1`, vals as any[]);
  }

  async findOpenEscalationBySession(sessionId: string): Promise<EscalationRecord | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM escalations WHERE session_id = $1 AND status <> 'RESOLVED' ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? rowToEscalation(rows[0]) : null;
  }

  // -- events -----------------------------------------------------------------
  async insertEvent(e: EventRecord): Promise<void> {
    await getPool().query('INSERT INTO events (session_id, type, payload) VALUES ($1,$2,$3)', [
      e.sessionId,
      e.type,
      JSON.stringify(e.payload ?? {}),
    ]);
  }

  async countEvents(type: string): Promise<number> {
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM events WHERE type = $1', [type]);
    return rows[0]?.n ?? 0;
  }
}
