import { getStore } from '../db/index.js';
import type { EscalationReason, SessionRecord } from '../db/types.js';

/**
 * The learning loop. Every escalation writes what the user actually asked, and
 * every resolution writes what the human said back. Ranked by frequency, that
 * list is the backlog: the questions the bot should be able to answer next.
 */

export interface KnowledgeGap {
  reason: string;
  utterance: string;
  count: number;
  lastSeen: string;
  resolution?: string;
}

export async function recordGap(
  session: SessionRecord,
  reason: EscalationReason,
  userUtterance: string,
): Promise<void> {
  await getStore().insertEvent({
    sessionId: session.id,
    type: 'knowledge_gap',
    payload: {
      reason,
      utterance: userUtterance.slice(0, 300),
      state: session.state,
      ts: new Date().toISOString(),
    },
  });
}

export async function recordResolution(sessionId: string, ticket: string, resolution: string): Promise<void> {
  await getStore().insertEvent({
    sessionId,
    type: 'gap_resolved',
    payload: { ticket, resolution: resolution.slice(0, 500), ts: new Date().toISOString() },
  });
}

/** Top gaps by reason, with a representative utterance. Postgres only. */
export async function topGaps(limit = 10): Promise<KnowledgeGap[]> {
  const store = getStore();
  if (store.kind !== 'postgres') return [];
  const rows = await store.rawQuery<{ reason: string; utterance: string; count: string; last_seen: string }>(
    `SELECT payload->>'reason' AS reason,
            (array_agg(payload->>'utterance' ORDER BY created_at DESC))[1] AS utterance,
            count(*) AS count,
            max(created_at) AS last_seen
     FROM events
     WHERE type = 'knowledge_gap'
     GROUP BY payload->>'reason'
     ORDER BY count(*) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    reason: r.reason ?? 'UNKNOWN',
    utterance: r.utterance ?? '',
    count: Number(r.count),
    lastSeen: r.last_seen,
  }));
}
