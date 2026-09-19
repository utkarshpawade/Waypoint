import { randomUUID } from 'node:crypto';
import { getStore } from '../db/index.js';
import type { SessionRecord, SessionSlots } from '../db/types.js';

export function emptySlots(): SessionSlots {
  return {
    trip: {},
    passengers: [],
    draftPassenger: {},
    lowConfidenceStreak: 0,
    corrections: 0,
    clarifyCount: {},
  };
}

/** Silent defaults (PLAN §10.2) — never ask about these, just assume them. */
export function withTripDefaults(session: SessionRecord): SessionRecord {
  const t = session.slots.trip;
  t.adults ??= 1;
  t.cabin ??= 'ECONOMY';
  t.preference ??= 'BEST_VALUE';
  t.tripType ??= t.returnDate ? 'ROUND_TRIP' : 'ONE_WAY';
  return session;
}

export async function loadOrCreateSession(
  channel: string,
  channelUserId: string,
  displayName?: string,
): Promise<SessionRecord> {
  const store = getStore();
  const existing = await store.getSessionByChannelUser(channel, channelUserId);
  if (existing) {
    // Defensive: a session written by an older build may lack newer slot keys.
    existing.slots = { ...emptySlots(), ...existing.slots };
    if (displayName && !existing.displayName) existing.displayName = displayName;
    return existing;
  }
  return store.createSession({
    id: randomUUID(),
    channel,
    channelUserId,
    displayName: displayName ?? null,
    state: 'GREETING',
    slots: emptySlots(),
    offers: null,
    selectedOfferId: null,
    control: 'BOT',
  });
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await getStore().saveSession(session);
}

/** Wipe the trip but keep the person — "start over" should not forget who you are. */
export function resetTrip(session: SessionRecord): void {
  session.slots.trip = {};
  session.slots.passengers = [];
  session.slots.draftPassenger = {};
  session.slots.clarifyCount = {};
  session.slots.pendingDisambiguation = undefined;
  session.slots.bookingRef = undefined;
  session.offers = null;
  session.selectedOfferId = null;
  session.state = 'COLLECTING_TRIP';
}
