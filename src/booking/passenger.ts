import { isInternational } from '../flights/airports.js';
import { FIELD_PROMPTS, validatePassengerDraft } from '../conversation/tools.js';
import type { PassengerDraft, SessionRecord } from '../db/types.js';

/**
 * Passenger collection, one traveller at a time, at most two fields per
 * message. The engine owns the transitions; this file owns what to ask next.
 */

export function totalPassengers(session: SessionRecord): number {
  const t = session.slots.trip;
  return (t.adults ?? 1) + (t.children ?? 0);
}

export function passengerIndex(session: SessionRecord): number {
  return session.slots.passengers.length + 1;
}

export function routeIsInternational(session: SessionRecord): boolean {
  const { origin, destination } = session.slots.trip;
  return Boolean(origin && destination && isInternational(origin, destination));
}

export function checkDraft(session: SessionRecord, draft: PassengerDraft = session.slots.draftPassenger) {
  return validatePassengerDraft(draft as Record<string, unknown>, {
    international: routeIsInternational(session),
    departDate: session.slots.trip.departDate,
  });
}

/**
 * The next prompt for this passenger: corrections first (a wrong value blocks
 * progress), then at most two missing fields.
 */
export function nextPassengerPrompt(session: SessionRecord): string | null {
  const total = totalPassengers(session);
  const index = passengerIndex(session);
  const { missing, errors } = checkDraft(session);

  const who = total > 1 ? `Passenger ${index} of ${total}` : 'Traveller';

  const errorFields = Object.keys(errors);
  if (errorFields.length) {
    const field = errorFields[0];
    return `${errors[field]} — could you send the ${FIELD_PROMPTS[field] ?? field} again?`;
  }

  if (!missing.length) return null;

  const ask = missing.slice(0, 2).map((f) => FIELD_PROMPTS[f] ?? f);
  const question = ask.length === 1 ? ask[0] : `${ask[0]}, and ${ask[1]}`;

  // The first question for a passenger carries the "N of M" framing; later
  // ones in the same passenger do not, so it doesn't read like a form.
  const started = Object.values(session.slots.draftPassenger).some(Boolean);
  return started ? `Thanks — now the ${question}?` : `${who} — ${question}?`;
}

export function passengerSummary(draft: PassengerDraft): string {
  const bits = [draft.fullName, draft.dateOfBirth, draft.gender].filter(Boolean);
  return bits.join(' · ');
}
