import { DateTime } from 'luxon';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logger, maskId } from '../logger.js';
import type { Channel, InboundMessage } from '../channels/types.js';
import { getAirport, isInternational } from '../flights/airports.js';
import { getFlightProvider } from '../flights/provider.js';
import { applyFilters, formatINR, topThree } from '../flights/ranking.js';
import type { FlightOffer, RankedPick, SearchQuery } from '../flights/types.js';
import { evaluateEscalation, nextLowConfidenceStreak, HIGH_VALUE_THRESHOLD } from '../escalation/policy.js';
import { escalate } from '../escalation/service.js';
import { handleOwnerCommand, isOwner, looksLikeCommand } from '../escalation/owner-commands.js';
import { createQuote, HOLD_MINUTES, paymentLinkFor } from '../booking/service.js';
import { checkDraft, nextPassengerPrompt, passengerIndex, totalPassengers } from '../booking/passenger.js';
import { interpretTurn, type TurnDecision } from './interpret.js';
import { isHandoffEntry, lookupKb } from './kb.js';
import { loadOrCreateSession, resetTrip, saveSession, withTripDefaults } from './session.js';
import { isToolAllowed } from './states.js';
import { validateToolArgs } from './tools.js';
import {
  describePax,
  itineraryCard,
  optionsMessage,
  searchingMessage,
  selectionMessage,
} from './formatter.js';
import type { SessionRecord, TripSlots } from '../db/types.js';

const log = logger.child({ mod: 'engine' });

const GREETING = "Hi! I'm Waypoint ✈️ I'll find you the best fare in about a minute.\nWhere from, and where to?";

/**
 * Is this sender one the bot should answer?
 *
 * With ALLOWED_SENDERS empty (the default) the answer is always yes. Setting it
 * makes the bot deaf to everyone else, which is what makes it safe to run on a
 * number a human also uses: the interviewer gets a working bot, and everyone
 * else's messages arrive as ordinary messages to the person.
 */
export function isAllowedSender(channelUserId: string): boolean {
  if (!config.allowedSenders.length) return true;

  const digits = channelUserId.split(':')[0].split('@')[0].replace(/\D/g, '');
  // Not a phone number at all — a CLI or test identifier like "e2e-user", whose
  // stray digits must not be read as one. The guard only governs real numbers.
  if (digits.length < 8) return true;

  // Compare the last ten digits, so a country code on one side and not the
  // other still matches. Ten is short enough to be forgiving and long enough
  // that two different people cannot collide.
  const tail = (n: string) => n.slice(-10);
  return config.allowedSenders.some((allowed) => tail(allowed) === tail(digits));
}

/** One user turn, end to end. Every transition below is the FSM's, not the model's. */
export async function handleTurn(msg: InboundMessage, channel: Channel): Promise<void> {
  const store = getStore();

  // The on-call human talks to the bot through the same socket as everyone else.
  if (isOwner(msg.channelUserId) && looksLikeCommand(msg.text)) {
    const result = await handleOwnerCommand(msg.text);
    if (result.handled && result.reply) await channel.send(msg.channelUserId, result.reply);
    return;
  }

  if (!isAllowedSender(msg.channelUserId)) {
    log.info({ from: maskId(msg.channelUserId) }, 'sender not in ALLOWED_SENDERS — staying silent');
    return;
  }

  const session = withTripDefaults(await loadOrCreateSession(channel.name, msg.channelUserId, msg.name));

  // Idempotency: reconnects replay messages, and answering twice is worse than
  // not answering at all.
  const fresh = await store.insertMessage({
    sessionId: session.id,
    waMsgId: msg.messageId ?? null,
    direction: 'IN',
    author: 'USER',
    body: msg.text,
  });
  if (!fresh) {
    log.info({ id: msg.messageId }, 'duplicate inbound ignored');
    return;
  }

  // A human has the conversation: relay, stay silent.
  if (session.control === 'HUMAN') {
    await relayToAgent(session, msg.text);
    return;
  }

  const history = await store.recentMessages(session.id, 10);
  let decision: TurnDecision;
  let providerFailure = false;

  try {
    decision = await interpretTurn(session, msg.text, history.map((m) => ({ author: m.author, body: m.body })));
  } catch (err) {
    log.error({ err }, 'interpretation failed entirely');
    providerFailure = true;
    decision = {
      intent: 'UNKNOWN',
      confidence: 0.2,
      trip: {},
      passenger: {},
      ambiguousPlaces: [],
      flags: { wantsHuman: false, frustrated: false, correction: false, pastDate: false, greeting: false },
      source: 'rules',
    };
  }

  if (decision.flags.correction) session.slots.corrections++;

  // ── escalation policy runs before any work is done ───────────────────────
  const open = await store.findOpenEscalationBySession(session.id);
  const kbHit = lookupKb(msg.text);
  const policy = evaluateEscalation({
    text: msg.text,
    intent: decision.intent,
    confidence: decision.confidence,
    lowConfidenceStreak: session.slots.lowConfidenceStreak,
    recentCorrections: session.slots.corrections,
    kbMiss: decision.intent === 'FAQ' && !kbHit,
    providerFailure,
    quoteTotal: selectedOffer(session)?.price.total,
    paxCount: totalPassengers(session),
    alreadyEscalated: Boolean(open),
  });

  session.slots.lowConfidenceStreak = nextLowConfidenceStreak(
    session.slots.lowConfidenceStreak,
    decision.confidence,
  );

  if (policy.escalate && policy.reason) {
    const result = await escalate({ session, reason: policy.reason, detail: policy.detail });
    // If the knowledge base has a holding line for this topic, the user gets
    // that first — "I won't guess on something that can stop you at the gate"
    // is a better answer than silence plus a ticket number.
    if (kbHit && isHandoffEntry(kbHit.entry) && policy.reason === 'POLICY_SENSITIVE') {
      await reply(session, channel, kbHit.entry.answer, decision);
    }
    if (result.userMessage) await reply(session, channel, result.userMessage, decision);
    return;
  }

  // ── the model may propose a tool; the state decides whether it runs ───────
  if (decision.tool) {
    if (!isToolAllowed(session.state, decision.tool)) {
      log.warn({ tool: decision.tool, state: session.state }, 'tool proposal rejected by state');
      decision.tool = undefined;
    } else {
      const validated = validateToolArgs(decision.tool, decision.args);
      if (!validated.ok) {
        log.warn({ tool: decision.tool, error: validated.error }, 'tool args rejected');
        decision.tool = undefined;
      } else {
        decision.args = validated.args as Record<string, unknown>;
      }
    }
  }

  let messages: string[];
  try {
    messages = await route(session, decision, msg.text, kbHit);
  } catch (err) {
    log.error({ err }, 'routing failed');
    const result = await escalate({
      session,
      reason: 'PROVIDER_FAILURE',
      detail: `internal error: ${(err as Error).message}`,
    });
    messages = result.userMessage ? [result.userMessage] : ['Something went wrong on my side — a human is on it.'];
  }

  for (const m of messages) await reply(session, channel, m, decision);
  await saveSession(session);
}

// ─────────────────────────────────────────────────────────────────────────────
// State router
// ─────────────────────────────────────────────────────────────────────────────

async function route(
  session: SessionRecord,
  d: TurnDecision,
  text: string,
  kbHit: ReturnType<typeof lookupKb>,
): Promise<string[]> {
  // Global intents, legal from any state.
  if (d.intent === 'RESTART') {
    resetTrip(session);
    withTripDefaults(session);
    return ['Starting fresh 🙂 Where are you flying from, and where to?'];
  }

  if (d.intent === 'FAQ' || d.tool === 'answer_faq') {
    const answer = await answerFaq(session, text, kbHit);
    if (answer) return answer;
  }

  if (session.slots.pendingDateFix) {
    const resolved = resolveDateFix(session, d, text);
    if (resolved) return resolved;
  }

  if (session.slots.pendingDisambiguation) {
    const resolved = resolveDisambiguation(session, text);
    if (resolved) return resolved;
  }

  switch (session.state) {
    case 'GREETING':
    case 'COLLECTING_TRIP':
      return collectTrip(session, d);

    case 'SEARCHING':
    case 'PRESENTING_OPTIONS':
    case 'AWAITING_SELECTION':
      return awaitingSelection(session, d);

    case 'COLLECTING_PASSENGER':
      return collectPassenger(session, d);

    case 'CONFIRMING':
      return confirming(session, d);

    case 'COMPLETED':
      return completed(session, d);

    default:
      // ESCALATED / HUMAN_CONTROL are handled before routing; ISSUING is transient.
      return [];
  }
}

// ── trip collection ──────────────────────────────────────────────────────────

async function collectTrip(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  const prefix: string[] = [];
  if (!session.slots.greeted) {
    session.slots.greeted = true;
    prefix.push(GREETING);
  }

  const ambiguity = mergeTripInto(session, d);
  if (ambiguity) return [...prefix.slice(0, 1), ambiguity];

  const pastDate = checkPastDate(session);
  if (pastDate) return [...prefix.slice(0, 1), pastDate];

  withTripDefaults(session);
  session.state = 'COLLECTING_TRIP';

  const missing = missingTripSlots(session.slots.trip);
  if (!missing.length) return [...prefix, ...(await runSearch(session))];

  // Ask at most two, and only if we haven't already asked the same thing twice.
  const question = askFor(session, missing);
  return prefix.length ? [prefix[0]] : [question];
}

function missingTripSlots(t: TripSlots): ('origin' | 'destination' | 'departDate')[] {
  const missing: ('origin' | 'destination' | 'departDate')[] = [];
  if (!t.origin) missing.push('origin');
  if (!t.destination) missing.push('destination');
  if (!t.departDate) missing.push('departDate');
  return missing;
}

const SLOT_QUESTIONS: Record<string, string> = {
  origin: 'which city are you flying from',
  destination: 'where are you headed',
  departDate: 'what date',
};

function askFor(session: SessionRecord, missing: string[]): string {
  const ask = missing.slice(0, 2);
  for (const slot of ask) {
    session.slots.clarifyCount[slot] = (session.slots.clarifyCount[slot] ?? 0) + 1;
  }
  const known = knownSoFar(session.slots.trip);
  const q = ask.map((s) => SLOT_QUESTIONS[s]).join(', and ');
  const question = `${q.charAt(0).toUpperCase() + q.slice(1)}?`;
  return known ? `${known}\n${question}` : question;
}

/** Reflect back only what is settled, so the user never repeats themselves. */
function knownSoFar(t: TripSlots): string | null {
  const bits: string[] = [];
  if (t.origin && t.destination) bits.push(`*${t.origin} → ${t.destination}*`);
  else if (t.origin) bits.push(`from *${getAirport(t.origin)?.city ?? t.origin}*`);
  else if (t.destination) bits.push(`to *${getAirport(t.destination)?.city ?? t.destination}*`);
  if (t.departDate) bits.push(DateTime.fromISO(t.departDate).toFormat('ccc d LLL'));
  if ((t.adults ?? 1) > 1 || t.children || t.infants) bits.push(describePax(t));
  return bits.length ? `Got it — ${bits.join(', ')}.` : null;
}

/** Returns a question string when the merge needs the user to disambiguate. */
function mergeTripInto(session: SessionRecord, d: TurnDecision): string | null {
  const t = session.slots.trip;
  for (const [k, v] of Object.entries(d.trip)) {
    if (v !== undefined && v !== null) (t as Record<string, unknown>)[k] = v;
  }

  const ambiguous = d.ambiguousPlaces[0];
  if (ambiguous && !t[ambiguous.role === 'origin' ? 'origin' : 'destination']) {
    const options = ambiguous.options.slice(0, 4);
    session.slots.pendingDisambiguation = {
      slot: ambiguous.role === 'origin' ? 'origin' : 'destination',
      options: options.map((o) => o.iata),
    };
    const list = options.map((o) => `*${o.iata}* (${o.name})`).join(' or ');
    return `${options[0].city} has more than one airport — ${list}?`;
  }

  if (t.origin && t.origin === t.destination) {
    t.destination = undefined;
    return "That's the same airport for both ends — where are you actually flying to?";
  }
  return null;
}

function resolveDisambiguation(session: SessionRecord, text: string): string[] | null {
  const pending = session.slots.pendingDisambiguation!;
  const upper = text.toUpperCase();
  const chosen = pending.options.find((iata) => upper.includes(iata));
  if (!chosen) {
    const byName = pending.options.find((iata) => {
      const ap = getAirport(iata);
      return ap && new RegExp(`\\b${ap.name.split(' ')[0]}\\b`, 'i').test(text);
    });
    if (!byName) return null;
    session.slots.trip[pending.slot] = byName;
  } else {
    session.slots.trip[pending.slot] = chosen;
  }
  session.slots.pendingDisambiguation = undefined;
  return null; // fall through to normal routing with the slot now filled
}

function checkPastDate(session: SessionRecord): string | null {
  const t = session.slots.trip;
  if (!t.departDate) return null;
  const today = DateTime.now().setZone(config.BUSINESS_TZ).startOf('day');
  const d = DateTime.fromISO(t.departDate, { zone: config.BUSINESS_TZ });
  if (d >= today) return null;

  const suggested = d.plus({ years: 1 }).toISODate()!;
  session.slots.pendingDateFix = { field: 'departDate', suggested, original: t.departDate };
  t.departDate = undefined;
  return `${d.toFormat('d LLL')} has already gone by — did you mean *${DateTime.fromISO(suggested).toFormat(
    'd LLL yyyy',
  )}*? (yes, or give me the right date)`;
}

function resolveDateFix(session: SessionRecord, d: TurnDecision, text: string): string[] | null {
  const pending = session.slots.pendingDateFix!;
  if (d.trip.departDate) {
    session.slots.pendingDateFix = undefined;
    return null; // a new date was given; normal routing picks it up
  }
  if (d.intent === 'CONFIRM' || /^\s*(yes|yep|yeah|correct|right)\b/i.test(text)) {
    session.slots.trip[pending.field] = pending.suggested;
    session.slots.pendingDateFix = undefined;
    return null;
  }
  if (d.intent === 'DENY') {
    session.slots.pendingDateFix = undefined;
    return ['No problem — what date should I look at?'];
  }
  return null;
}

// ── search ───────────────────────────────────────────────────────────────────

function buildQuery(t: TripSlots): SearchQuery {
  return {
    origin: t.origin!,
    destination: t.destination!,
    departDate: t.departDate!,
    returnDate: t.returnDate,
    adults: t.adults ?? 1,
    children: t.children,
    infants: t.infants,
    cabin: t.cabin ?? 'ECONOMY',
    currency: 'INR',
    nonStopOnly: t.nonStopOnly,
    maxPrice: t.budgetMax,
    departWindow: t.departWindow,
  };
}

async function runSearch(session: SessionRecord): Promise<string[]> {
  const store = getStore();
  const t = session.slots.trip;
  const query = buildQuery(t);

  session.state = 'SEARCHING';
  const started = Date.now();
  const offers = await getFlightProvider().search(query);

  await store.insertEvent({
    sessionId: session.id,
    type: 'search_performed',
    payload: {
      route: `${query.origin}-${query.destination}`,
      date: query.departDate,
      offers: offers.length,
      ms: Date.now() - started,
    },
  });

  if (!offers.length) {
    const result = await escalate({
      session,
      reason: 'PROVIDER_FAILURE',
      detail: `no offers for ${query.origin}→${query.destination} on ${query.departDate}`,
    });
    return [
      `I couldn't find any fares for *${query.origin} → ${query.destination}* on that date, and I won't invent one.`,
      result.userMessage,
    ].filter(Boolean);
  }

  session.offers = offers;
  session.selectedOfferId = null;
  session.slots.activeFilters = {
    nonStopOnly: t.nonStopOnly,
    maxPrice: t.budgetMax,
    preference: t.preference,
    departWindow: t.departWindow,
  };

  return [searchingMessage(t), ...presentOptions(session)];
}

/** Rank the cached set under the active filters and render the three cards. */
function presentOptions(session: SessionRecord, note?: string): string[] {
  const t = session.slots.trip;
  const filters = session.slots.activeFilters ?? {};
  const all = session.offers ?? [];

  let pool = applyFilters(all, filters);
  let relaxed: string | null = null;

  if (!pool.length) {
    // Never answer "nothing matches" when there is a near miss to show.
    pool = applyFilters(all, { ...filters, maxPrice: undefined });
    if (pool.length) {
      const cheapest = Math.min(...pool.map((o) => o.price.total));
      relaxed = `Nothing under ${formatINR(filters.maxPrice!)} on this route — the closest I have is ${formatINR(
        cheapest,
      )}.`;
    } else {
      pool = applyFilters(all, { preference: filters.preference });
      relaxed = 'Nothing matched all of that, so here are the closest options.';
    }
  }
  if (!pool.length) pool = all;

  const picks = topThree(pool, t.preference ?? 'BEST_VALUE');
  session.slots.pickIds = picks.map((p) => p.offer.id);
  session.state = 'AWAITING_SELECTION';

  const out: string[] = [];
  if (note) out.push(note);
  if (relaxed) out.push(relaxed);
  out.push(optionsMessage(picks, t));
  return out;
}

// ── selection & refinement ───────────────────────────────────────────────────

async function awaitingSelection(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  // A new city or date means a new search, not a refinement.
  const routeChanged =
    (d.trip.origin && d.trip.origin !== session.slots.trip.origin) ||
    (d.trip.destination && d.trip.destination !== session.slots.trip.destination) ||
    (d.trip.departDate && d.trip.departDate !== session.slots.trip.departDate);

  if (routeChanged) {
    const ambiguity = mergeTripInto(session, d);
    if (ambiguity) return [ambiguity];
    const past = checkPastDate(session);
    if (past) return [past];
    if (!missingTripSlots(session.slots.trip).length) return runSearch(session);
    session.state = 'COLLECTING_TRIP';
    return [askFor(session, missingTripSlots(session.slots.trip))];
  }

  if (d.selection !== undefined || d.tool === 'select_flight') {
    const index = d.selection ?? Number((d.args as { index?: number })?.index ?? 0);
    return selectOption(session, index);
  }

  // Anything that narrows the set is a refinement against the cache — instant,
  // and it costs no provider or model quota.
  const refinement = collectRefinement(session, d);
  if (refinement) {
    return presentOptions(session, refinement);
  }

  if (d.intent === 'CONFIRM') {
    return ['Which one — reply *1*, *2* or *3*?'];
  }

  return ['Reply *1*, *2* or *3* to pick one — or tell me what to change (cheaper, non-stop, morning, a different date).'];
}

function collectRefinement(session: SessionRecord, d: TurnDecision): string | null {
  const filters = { ...(session.slots.activeFilters ?? {}) };
  const t = session.slots.trip;
  const applied: string[] = [];

  const args = (d.args ?? {}) as Record<string, unknown>;
  const src = {
    nonStopOnly: d.trip.nonStopOnly ?? (typeof args.nonStopOnly === 'boolean' ? args.nonStopOnly : undefined),
    maxPrice: d.trip.budgetMax ?? (typeof args.maxPrice === 'number' ? args.maxPrice : undefined),
    preference: d.trip.preference ?? (typeof args.preference === 'string' ? args.preference : undefined),
    departWindow: d.trip.departWindow ?? (args.departWindow as { earliest?: string; latest?: string } | undefined),
    cabin: d.trip.cabin,
    adults: d.trip.adults,
  };

  // Only report what actually changed. The model likes to restate slots it was
  // not asked about ("stops allowed" when the user only said "cheaper"), and
  // echoing those back reads like the bot misheard.
  // `undefined` and `false` both mean "no non-stop filter", so a model that
  // helpfully restates nonStopOnly:false is not a change worth announcing.
  if (src.nonStopOnly !== undefined && Boolean(src.nonStopOnly) !== Boolean(filters.nonStopOnly)) {
    filters.nonStopOnly = src.nonStopOnly;
    t.nonStopOnly = src.nonStopOnly;
    applied.push(src.nonStopOnly ? 'non-stop only' : 'stops allowed');
  }
  if (src.maxPrice !== undefined && src.maxPrice !== filters.maxPrice) {
    filters.maxPrice = src.maxPrice;
    t.budgetMax = src.maxPrice;
    applied.push(`under ${formatINR(src.maxPrice)}`);
  }
  if (src.preference !== undefined && src.preference !== filters.preference) {
    filters.preference = src.preference as typeof filters.preference;
    t.preference = src.preference as typeof t.preference;
    applied.push(src.preference === 'CHEAPEST' ? 'cheapest first' : src.preference.toLowerCase().replace('_', ' '));
  }
  if (src.departWindow !== undefined && !sameWindow(src.departWindow, filters.departWindow)) {
    filters.departWindow = src.departWindow;
    t.departWindow = src.departWindow;
    applied.push(`departing ${src.departWindow.earliest ?? '00:00'}–${src.departWindow.latest ?? '23:59'}`);
  }

  if (!applied.length) return null;

  session.slots.activeFilters = filters;
  void getStore().insertEvent({
    sessionId: session.id,
    type: 'search_refined',
    payload: { filters: applied },
  });
  return `Re-ranking for *${applied.join(', ')}* — no new search needed 👇`;
}

function sameWindow(
  a: { earliest?: string; latest?: string } | undefined,
  b: { earliest?: string; latest?: string } | undefined,
): boolean {
  return a?.earliest === b?.earliest && a?.latest === b?.latest;
}

async function selectOption(session: SessionRecord, index: number): Promise<string[]> {
  const ids = session.slots.pickIds ?? [];
  const id = ids[index - 1];
  const offer = session.offers?.find((o) => o.id === id);
  if (!offer) return ['I lost track of which option that was — reply *1*, *2* or *3* and I\'ll lock it in.'];

  session.selectedOfferId = offer.id;
  await getStore().insertEvent({
    sessionId: session.id,
    type: 'offer_selected',
    payload: { id: offer.id, total: offer.price.total, index },
  });

  // A quote this size gets a human's eyes before anything is issued.
  if (offer.price.total > HIGH_VALUE_THRESHOLD) {
    const result = await escalate({
      session,
      reason: 'HIGH_VALUE',
      detail: `quote of ${formatINR(offer.price.total)}`,
    });
    return [pickLine(session, index), result.userMessage].filter(Boolean);
  }

  session.state = 'COLLECTING_PASSENGER';
  session.slots.draftPassenger = {};
  return [pickLine(session, index), nextPassengerPrompt(session) ?? 'Now your details, please.'];
}

function pickLine(session: SessionRecord, index: number): string {
  const offer = selectedOffer(session)!;
  const picks = session.slots.pickIds ?? [];
  const label = (['CHEAPEST', 'FASTEST', 'BEST_VALUE'] as const)[picks.indexOf(offer.id)] ?? 'BEST_VALUE';
  const pick: RankedPick = { label, offer, score: 0, whyThisOne: '' };
  return selectionMessage(pick, session.slots.trip);
}

// ── passenger collection ─────────────────────────────────────────────────────

async function collectPassenger(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  if (d.intent === 'DENY' && !Object.values(d.passenger).some(Boolean)) {
    session.state = 'AWAITING_SELECTION';
    return ['No problem — here are your options again.', ...presentOptions(session)];
  }

  const draft = session.slots.draftPassenger;
  for (const [k, v] of Object.entries(d.passenger)) {
    if (v !== undefined && v !== null && v !== '') (draft as Record<string, unknown>)[k] = v;
  }

  const { valid, errors } = checkDraft(session);
  if (!valid) {
    const prompt = nextPassengerPrompt(session);
    if (Object.keys(errors).length) {
      void getStore().insertEvent({
        sessionId: session.id,
        type: 'passenger_validation_failed',
        payload: { fields: Object.keys(errors) },
      });
    }
    return [prompt ?? 'Could you send that again?'];
  }

  session.slots.passengers.push({ ...draft });
  session.slots.draftPassenger = {};

  const total = totalPassengers(session);
  if (session.slots.passengers.length < total) {
    const next = nextPassengerPrompt(session);
    return [`✅ Passenger ${session.slots.passengers.length} saved.`, next ?? `Passenger ${passengerIndex(session)}?`];
  }

  session.state = 'CONFIRMING';
  return [confirmationMessage(session)];
}

function confirmationMessage(session: SessionRecord): string {
  const offer = selectedOffer(session)!;
  const seg = offer.outbound.segments[0];
  const last = offer.outbound.segments.at(-1)!;
  const names = session.slots.passengers.map((p) => p.fullName).join(', ');
  const email = session.slots.passengers.find((p) => p.email)?.email ?? 'your email';
  return [
    '🎫 *Ready to issue*',
    `${seg.carrierName} ${seg.flightNumber} · ${seg.departISO.slice(11, 16)} ${seg.from} → ${last.arriveISO.slice(
      11,
      16,
    )} ${last.to}`,
    `${describePax(session.slots.trip)} · ${names}`,
    `Total *${formatINR(offer.price.total)}*`,
    '',
    `I'll email the itinerary and payment link to ${email}. Shall I go ahead? (*yes* / *no*)`,
  ].join('\n');
}

// ── confirmation & issue ─────────────────────────────────────────────────────

async function confirming(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  if (d.intent === 'DENY') {
    session.state = 'AWAITING_SELECTION';
    return ['No problem — nothing has been booked. Here are the options again.', ...presentOptions(session)];
  }

  // New passenger details at this point are a correction, not a confirmation.
  if (Object.values(d.passenger).some(Boolean)) {
    const last = session.slots.passengers.pop();
    session.slots.draftPassenger = { ...last, ...cleaned(d.passenger) };
    session.state = 'COLLECTING_PASSENGER';
    return collectPassenger(session, { ...d, passenger: {} });
  }

  if (d.intent !== 'CONFIRM' && d.tool !== 'confirm_booking') {
    return [`Just say *yes* and I'll issue it, or *no* to change something.`];
  }

  return issueBooking(session);
}

function cleaned<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

async function issueBooking(session: SessionRecord): Promise<string[]> {
  session.state = 'ISSUING';
  const offer = selectedOffer(session)!;
  const result = await createQuote(session, offer);
  session.slots.bookingRef = result.booking.ref;

  const email = result.booking.emailTo ?? '';
  const card = itineraryCard({
    ref: result.booking.ref,
    offer,
    passengers: result.passengers,
    email: email || 'your email',
    paymentLink: paymentLinkFor(result.booking.ref),
    holdMinutes: HOLD_MINUTES,
  });

  session.state = 'COMPLETED';

  if (result.emailed) return [card];

  // Never claim an email was sent when it wasn't.
  const honest =
    `⚠️ I couldn't get the email through to ${email || 'your address'}` +
    (result.emailSimulated ? ' (email delivery is not configured on this deployment)' : '') +
    `. Everything above is still valid — use the link directly, and I've flagged it to a human.`;

  const esc = await escalate({
    session,
    reason: 'PROVIDER_FAILURE',
    detail: `itinerary email failed: ${result.emailError ?? 'unknown'}`,
  });
  return [card, honest, esc.userMessage].filter(Boolean);
}

// ── after the booking ────────────────────────────────────────────────────────

async function completed(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  if (d.trip.origin || d.trip.destination || d.trip.departDate) {
    const ref = session.slots.bookingRef;
    resetTrip(session);
    withTripDefaults(session);
    const ambiguity = mergeTripInto(session, d);
    if (ambiguity) return [ambiguity];
    const missing = missingTripSlots(session.slots.trip);
    const lead = ref ? `Sure — ${ref} is all set. New trip:` : 'Sure —';
    if (!missing.length) return [...(await runSearch(session))];
    return [`${lead} ${askFor(session, missing)}`];
  }

  if (d.intent === 'CONFIRM' || d.intent === 'GREET') {
    return [`Anything else? I can search another route, or answer questions about baggage and check-in.`];
  }

  return [
    `Your itinerary *${session.slots.bookingRef ?? ''}* is emailed and held. ` +
      `Want me to look at another trip, or anything about baggage or check-in?`,
  ];
}

// ── FAQ ──────────────────────────────────────────────────────────────────────

async function answerFaq(
  session: SessionRecord,
  text: string,
  kbHit: ReturnType<typeof lookupKb>,
): Promise<string[] | null> {
  if (!kbHit) return null; // the policy layer escalates a knowledge gap

  if (isHandoffEntry(kbHit.entry)) {
    const result = await escalate({
      session,
      reason: 'POLICY_SENSITIVE',
      detail: kbHit.entry.topic,
      botTried: [`matched KB entry ${kbHit.entry.id}, which is flagged for human handling`],
    });
    return [kbHit.entry.answer, result.userMessage].filter(Boolean);
  }

  void getStore().insertEvent({
    sessionId: session.id,
    type: 'faq_answered',
    payload: { entry: kbHit.entry.id, score: kbHit.score },
  });

  const followUp =
    session.state === 'AWAITING_SELECTION'
      ? '\n\nStill happy to book one of those three — reply *1*, *2* or *3*.'
      : session.state === 'COLLECTING_PASSENGER'
        ? `\n\n${nextPassengerPrompt(session) ?? ''}`
        : '';
  return [`${kbHit.entry.answer}${followUp}`];
}

// ── outbound ─────────────────────────────────────────────────────────────────

/**
 * Programmatic anti-hallucination check.
 *
 * Engine-authored text is built from tool results by construction. Model-authored
 * text is not, so any fare or flight number in it must appear in the session's
 * offer cache — otherwise the message is suppressed and the turn escalates.
 */
export function verifyOutbound(
  text: string,
  offers: FlightOffer[] | null,
  /** Amounts the user themselves supplied — a stated budget is their number, not ours. */
  userAmounts: number[] = [],
): { ok: boolean; offending?: string } {
  const fares: number[] = [];
  const allowedAmounts = new Set<number>(userAmounts);
  const allowedFlights = new Set<string>();

  for (const o of offers ?? []) {
    for (const value of [o.price.total, o.price.perAdult]) {
      fares.push(value);
      allowedAmounts.add(value);
    }
    for (const s of [...o.outbound.segments, ...(o.inbound?.segments ?? [])]) {
      allowedFlights.add(s.flightNumber.replace(/\s|-/g, '').toUpperCase());
    }
  }

  // The "why this one" lines quote differences between two cached fares
  // ("₹3,840 cheaper than the fastest"). Those are derived from tool results,
  // so they are legitimate — but only the exact deltas, nothing else.
  for (const a of fares) {
    for (const b of fares) {
      const delta = Math.abs(a - b);
      if (delta) allowedAmounts.add(delta);
    }
  }

  // Our own booking and ticket references are random base36, so one can contain
  // a run that reads exactly like a flight number (WP-DD3268 → "DD3268").
  // Remove them before scanning rather than trying to except them afterwards.
  const scannable = text.replace(/\bWP-[A-Z0-9]{4,8}\b/g, ' ');

  for (const m of scannable.matchAll(/₹\s?([\d,]+)/g)) {
    const value = Number(m[1].replace(/,/g, ''));
    if (!allowedAmounts.has(value)) return { ok: false, offending: m[0] };
  }
  for (const m of scannable.matchAll(/\b([A-Z0-9]{2}[- ]?\d{2,4})\b/g)) {
    const norm = m[1].replace(/\s|-/g, '').toUpperCase();
    if (/^\d/.test(norm)) continue; // not an airline code
    if (!allowedFlights.has(norm)) return { ok: false, offending: m[1] };
  }
  return { ok: true };
}

async function reply(session: SessionRecord, channel: Channel, text: string, d: TurnDecision): Promise<void> {
  let body = text;

  // Belt and braces: every outbound message is checked, not just the ones the
  // model wrote. Engine-authored text is built from tool results and passes by
  // construction — if it ever stops passing, that is a bug worth catching.
  if (/₹|\b[A-Z0-9]{2}-\d{2,4}\b/.test(text)) {
    const userAmounts = [session.slots.trip.budgetMax, selectedOffer(session)?.price.total].filter(
      (n): n is number => typeof n === 'number',
    );
    const check = verifyOutbound(text, session.offers, userAmounts);
    if (!check.ok) {
      log.error({ offending: check.offending }, 'hallucination_blocked');
      await getStore().insertEvent({
        sessionId: session.id,
        type: 'hallucination_blocked',
        payload: { offending: check.offending ?? '' },
      });
      const result = await escalate({
        session,
        reason: 'PROVIDER_FAILURE',
        detail: `blocked an unverifiable fact in a draft reply (${check.offending})`,
      });
      body = result.userMessage || "Let me get that checked rather than guess — I've flagged it to a human.";
    }
  }

  await channel.send(session.channelUserId, body);
  await getStore().insertMessage({
    sessionId: session.id,
    direction: 'OUT',
    author: 'BOT',
    body,
    confidence: d.confidence,
    intent: d.intent,
  });
}

async function relayToAgent(session: SessionRecord, text: string): Promise<void> {
  const { sendTo } = await import('../channels/registry.js');
  const { ownerJid } = await import('../escalation/service.js');
  const owner = ownerJid();
  const ticket = session.slots.escalationTicket ?? '';
  if (owner) {
    await sendTo(owner, `💬 *${ticket}* ${maskId(session.channelUserId.split('@')[0])}:\n${text}`);
  }
  log.info({ ticket, from: maskId(session.channelUserId) }, 'relayed user message to agent');
}

function selectedOffer(session: SessionRecord): FlightOffer | undefined {
  if (!session.selectedOfferId) return undefined;
  return session.offers?.find((o) => o.id === session.selectedOfferId);
}

export { isInternational };
