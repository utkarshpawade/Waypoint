import { getStore } from '../db/index.js';

/**
 * Plain SQL over the events table. Containment, time-to-quote, turns-to-search,
 * escalation mix, the drop-off funnel and the knowledge-gap register — the
 * numbers that turn "it works" into "here is how well, and where it doesn't".
 */

export interface Metrics {
  sessions: number;
  completed: number;
  escalated: number;
  containmentRate: number | null;
  medianSecondsToFirstQuote: number | null;
  medianTurnsToSearch: number | null;
  escalationMix: { reason: string; count: number }[];
  funnel: { state: string; count: number }[];
  topGaps: { reason: string; utterance: string; count: number }[];
  bookings: { quoted: number; paid: number };
  available: boolean;
}

const EMPTY: Metrics = {
  sessions: 0,
  completed: 0,
  escalated: 0,
  containmentRate: null,
  medianSecondsToFirstQuote: null,
  medianTurnsToSearch: null,
  escalationMix: [],
  funnel: [],
  topGaps: [],
  bookings: { quoted: 0, paid: 0 },
  available: false,
};

export async function computeMetrics(): Promise<Metrics> {
  const store = getStore();
  if (store.kind !== 'postgres') return EMPTY;

  const q = <T>(sql: string, params: unknown[] = []) => store.rawQuery<T>(sql, params);

  const [counts] = await q<{ sessions: string; completed: string; escalated: string }>(
    `SELECT count(*) AS sessions,
            count(*) FILTER (WHERE state = 'COMPLETED') AS completed,
            count(*) FILTER (WHERE id IN (SELECT session_id FROM escalations)) AS escalated
     FROM sessions`,
  );

  const sessions = Number(counts?.sessions ?? 0);
  const completed = Number(counts?.completed ?? 0);
  const escalated = Number(counts?.escalated ?? 0);

  // Containment: reached COMPLETED without ever raising a ticket.
  const [contained] = await q<{ n: string }>(
    `SELECT count(*) AS n FROM sessions
     WHERE state = 'COMPLETED' AND id NOT IN (SELECT session_id FROM escalations)`,
  );

  const [timing] = await q<{ median: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS median FROM (
       SELECT EXTRACT(EPOCH FROM (min(e.created_at) - s.created_at)) AS secs
       FROM sessions s JOIN events e ON e.session_id = s.id AND e.type = 'search_performed'
       GROUP BY s.id, s.created_at
     ) t`,
  );

  const [turns] = await q<{ median: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median FROM (
       SELECT count(*) AS n
       FROM messages m
       JOIN (SELECT session_id, min(created_at) AS first_search
             FROM events WHERE type = 'search_performed' GROUP BY session_id) f
         ON f.session_id = m.session_id
       WHERE m.direction = 'IN' AND m.created_at <= f.first_search
       GROUP BY m.session_id
     ) t`,
  );

  const mix = await q<{ reason: string; count: string }>(
    `SELECT reason, count(*) AS count FROM escalations GROUP BY reason ORDER BY count(*) DESC`,
  );

  const funnel = await q<{ state: string; count: string }>(
    `SELECT state, count(*) AS count FROM sessions GROUP BY state ORDER BY count(*) DESC`,
  );

  const gaps = await q<{ reason: string; utterance: string; count: string }>(
    `SELECT payload->>'reason' AS reason,
            (array_agg(payload->>'utterance' ORDER BY created_at DESC))[1] AS utterance,
            count(*) AS count
     FROM events WHERE type = 'knowledge_gap'
     GROUP BY payload->>'reason' ORDER BY count(*) DESC LIMIT 8`,
  );

  const [bookings] = await q<{ quoted: string; paid: string }>(
    `SELECT count(*) AS quoted, count(*) FILTER (WHERE status = 'PAID') AS paid FROM bookings`,
  );

  return {
    sessions,
    completed,
    escalated,
    containmentRate: sessions ? Number(contained?.n ?? 0) / sessions : null,
    medianSecondsToFirstQuote: timing?.median !== null && timing?.median !== undefined ? Number(timing.median) : null,
    medianTurnsToSearch: turns?.median !== null && turns?.median !== undefined ? Number(turns.median) : null,
    escalationMix: mix.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    funnel: funnel.map((r) => ({ state: r.state, count: Number(r.count) })),
    topGaps: gaps.map((r) => ({ reason: r.reason ?? 'UNKNOWN', utterance: r.utterance ?? '', count: Number(r.count) })),
    bookings: { quoted: Number(bookings?.quoted ?? 0), paid: Number(bookings?.paid ?? 0) },
    available: true,
  };
}
