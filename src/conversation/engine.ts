import { DateTime } from 'luxon';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logger, maskId } from '../logger.js';
import type { Channel, InboundMessage } from '../channels/types.js';
import { getAirport, isInternational } from '../flights/airports.js';
import { getFlightProvider } from '../flights/provider.js';
import {
  applyFilters,
  arrivalMinutes,
  clockTime,
  departMinutes,
  formatINR,
  nearestPicks,
  topThree,
  windowMiss,
  type RefineFilters,
} from '../flights/ranking.js';
import type { FlightOffer, RankedPick, SearchQuery } from '../flights/types.js';
import { evaluateEscalation, nextLowConfidenceStreak, HIGH_VALUE_THRESHOLD } from '../escalation/policy.js';
import { escalate, resumeStateFor, sendAgentHandoffEmail } from '../escalation/service.js';
import { handleOwnerCommand, isOwner, looksLikeCommand } from '../escalation/owner-commands.js';
import { createQuote, HOLD_MINUTES, paymentLinkFor } from '../booking/service.js';
import { checkDraft, nextPassengerPrompt, passengerIndex, totalPassengers } from '../booking/passenger.js';
import { extractEmail } from '../llm/rules-fallback.js';
import { interpretTurn, timeWindow, type TurnDecision } from './interpret.js';
import { isHandoffEntry, lookupKb } from './kb.js';
import { loadOrCreateSession, resetTrip, saveSession, withTripDefaults } from './session.js';
import { isToolAllowed } from './states.js';
import { validateToolArgs } from './tools.js';
import {
  describeFilters,
  describePax,
  describeWindow,
  fitText,
  itineraryCard,
  optionsMessage,
  pickPrompt,
  replyHint,
  searchingMessage,
  selectionMessage,
} from './formatter.js';
import { conversationKey, withConversationLock } from './locks.js';
import type { SessionRecord, TripSlots } from '../db/types.js';

const log = logger.child({ mod: 'engine' });

const INTRO = "Hi! I'm Waypoint ✈️ I'll find you the best fare in about a minute.";
const GREETING = `${INTRO}\nWhere from, and where to?`;

/** Per-turn plumbing the state handlers need beyond the session itself. */
interface TurnCtx {
  /** Send a message now, mid-turn — "Searching…" must land before a slow search, not after it. */
  sendNow: (text: string) => Promise<void>;
  /** The previous bot message asked "shall I carry on?". */
  resumeOffered: boolean;
  /** The user's message, verbatim. */
  text: string;
}

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

  await withConversationLock(conversationKey(channel.name, msg.channelUserId), async () => {
    try {
      await runTurn(msg, channel);
    } catch (err) {
      // Whatever broke, the user is not left talking to a wall.
      log.error({ err }, 'turn failed');
      await channel
        .send(msg.channelUserId, 'Sorry — something went wrong on my side. Could you send that again?')
        .catch(() => {});
    }
  });
}

async function runTurn(msg: InboundMessage, channel: Channel): Promise<void> {
  const store = getStore();
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

  // An escalation is waiting on an address so the agent can write to them.
  // This runs before the muted-for-human check: it is the one thing the bot
  // should still do while a handoff is pending.
  if (session.slots.pendingHandoffEmail) {
    const handled = await completePendingHandoff(session, channel, msg.text);
    if (handled) return;
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
      flags: {
        wantsHuman: false,
        frustrated: false,
        correction: false,
        pastDate: false,
        greeting: false,
        clearFilters: false,
      },
      source: 'rules',
    };
  }

  // "Corrections in the last few turns", not ever: a clean turn lets one go,
  // so changing your mind twice in a long conversation is not "frustration".
  session.slots.corrections = decision.flags.correction
    ? session.slots.corrections + 1
    : Math.max(0, session.slots.corrections - 1);

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
    const result = await escalate({
      session,
      reason: policy.reason,
      detail: policy.detail,
      userQuestion: msg.text,
    });
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
        // Drop the arguments with the tool. Acting on args that failed
        // validation is how an invented preference once reached the ranker.
        decision.tool = undefined;
        decision.args = undefined;
      } else {
        decision.args = validated.args as Record<string, unknown>;
      }
    }
  }

  const ctx: TurnCtx = {
    sendNow: (text) => reply(session, channel, text, decision),
    resumeOffered: Boolean(session.slots.offeredToResume),
    text: msg.text,
  };
  session.slots.offeredToResume = undefined;

  let messages: string[];
  try {
    messages = await route(session, decision, msg.text, kbHit, ctx);
  } catch (err) {
    log.error({ err }, 'routing failed');
    const result = await escalate({
      session,
      reason: 'PROVIDER_FAILURE',
      detail: `internal error: ${(err as Error).message}`,
    });
    messages = result.userMessage ? [result.userMessage] : ['Something went wrong on my side — a human is on it.'];
  }

  // Every turn gets an answer. A state with nothing to say is a bug, but the
  // user should see a way forward rather than silence while it gets fixed.
  if (!messages.length) messages = [clarify(session, decision)];

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
  ctx: TurnCtx,
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

  // The bot is back in charge but the state still says "handed off" — pick up
  // from the furthest point it can safely continue, rather than saying nothing.
  if ((session.state === 'ESCALATED' || session.state === 'HUMAN_CONTROL') && session.control === 'BOT') {
    session.state = resumeStateFor(session);
  }

  // "Want me to carry on?" — "yes" means "show me where we were", not "which one?".
  if (ctx.resumeOffered && d.intent === 'CONFIRM') return resumeWhereWeWere(session, ctx);
  if (ctx.resumeOffered && d.intent === 'DENY') {
    return ["No problem — I'll leave it there. Message me any time and we'll pick up where we left off."];
  }

  switch (session.state) {
    case 'GREETING':
    case 'COLLECTING_TRIP':
      return collectTrip(session, d, ctx);

    case 'SEARCHING':
    case 'PRESENTING_OPTIONS':
    case 'AWAITING_SELECTION':
      return awaitingSelection(session, d, ctx);

    case 'COLLECTING_PASSENGER':
      return collectPassenger(session, d);

    case 'CONFIRMING':
      return confirming(session, d);

    case 'COMPLETED':
      return completed(session, d, ctx);

    default:
      // ESCALATED / HUMAN_CONTROL are handled before routing; ISSUING is transient.
      return [];
  }
}

// ── trip collection ──────────────────────────────────────────────────────────

async function collectTrip(session: SessionRecord, d: TurnDecision, ctx: TurnCtx): Promise<string[]> {
  const firstTurn = !session.slots.greeted;
  session.slots.greeted = true;

  const ambiguity = mergeTripInto(session, d);
  const heardSomething = Boolean(Object.keys(d.trip).length || ambiguity);
  // A first message that already says where ("flight from Delhi to Goa") gets
  // a one-line hello and the *next* question — never "where from, and where to?".
  const intro = firstTurn ? (heardSomething ? INTRO : GREETING) : null;
  const withIntro = (m: string) => (intro ? `${intro}\n\n${m}` : m);

  if (ambiguity) return [withIntro(ambiguity)];

  const pastDate = checkPastDate(session);
  if (pastDate) return [withIntro(pastDate)];

  withTripDefaults(session);
  session.state = 'COLLECTING_TRIP';

  const missing = missingTripSlots(session.slots.trip);
  if (!missing.length) return runSearch(session, ctx, intro ? INTRO : undefined);

  if (intro && !heardSomething) return [intro];
  return [withIntro(askFor(session, missing))];
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
  const filters = describeFilters({
    nonStopOnly: t.nonStopOnly,
    maxPrice: t.budgetMax,
    departWindow: t.departWindow,
    arriveWindow: t.arriveWindow,
  });
  if (filters) bits.push(filters);
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
    arriveWindow: t.arriveWindow,
  };
}

async function runSearch(session: SessionRecord, ctx: TurnCtx, intro?: string): Promise<string[]> {
  const store = getStore();
  const t = session.slots.trip;
  const query = buildQuery(t);

  session.state = 'SEARCHING';
  // Say what was heard *before* the wait: a live fare search takes seconds,
  // and silence while it runs reads as the bot having died.
  await ctx.sendNow(intro ? `${intro}\n\n${searchingMessage(t)}` : searchingMessage(t));
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
    arriveWindow: t.arriveWindow,
  };

  return presentOptions(session);
}

/**
 * Rank the cached set under the active filters and render the cards.
 *
 * When nothing meets every constraint, say exactly which one could not be met
 * and show the flights *nearest* to it — "nothing lands by 12:00; the earliest
 * is 13:05" is an answer, a silently ignored filter is not.
 */
function presentOptions(session: SessionRecord, opts: { applied?: string[]; lead?: string } = {}): string[] {
  const t = session.slots.trip;
  const filters = session.slots.activeFilters ?? {};
  const all = session.offers ?? [];

  let pool = applyFilters(all, filters);
  const active = describeFilters(filters);
  let header: string | undefined;
  let nearest: ReturnType<typeof relaxFilters>['nearest'];

  if (pool.length) {
    const fit = fitText(pool.length, all.length);
    if (opts.applied?.length) header = `Re-ranking for *${opts.applied.join(', ')}* — ${fit} 👇`;
    else if (opts.lead) header = active ? `${opts.lead}\n_${active} — ${fit}._` : opts.lead;
    else if (active) header = `*${active}* — ${fit}. Here are the best 👇`;
  } else {
    const relaxed = relaxFilters(all, filters);
    pool = relaxed.pool;
    nearest = relaxed.nearest;
    header = opts.lead ? `${opts.lead}\n${relaxed.note}` : relaxed.note;
  }
  if (!pool.length) pool = all;

  // A live provider that fell back to the simulator must not pass sample
  // fares off as real ones.
  if (config.FLIGHT_PROVIDER !== 'mock' && all.length && all.every((o) => o.provider === 'mock')) {
    header =
      `${header ?? 'Here are the best options 👇'}\n` +
      `_⚠️ Live fares are unavailable right now — these are sample fares, not bookable prices._`;
  }

  const picks = nearest
    ? nearestPicks(pool, nearest.which, nearest.window)
    : topThree(pool, t.preference ?? 'BEST_VALUE');
  session.slots.pickIds = picks.map((p) => p.offer.id);
  session.slots.pickLabels = picks.map((p) => p.label);
  session.state = 'AWAITING_SELECTION';
  return [optionsMessage(picks, t, header)];
}

type Relaxable = 'nonStopOnly' | 'departWindow' | 'maxPrice' | 'arriveWindow';

/**
 * The order constraints give way in when nothing meets all of them. A landing
 * deadline is usually a hard one (a meeting, a connection); a non-stop is a
 * preference. So stops give way first and the arrival time last.
 */
const RELAX_ORDER: Relaxable[] = ['nonStopOnly', 'departWindow', 'maxPrice', 'arriveWindow'];

function relaxFilters(
  all: FlightOffer[],
  filters: RefineFilters,
): {
  pool: FlightOffer[];
  note: string;
  /** Set when the constraint that gave way was a time: order the cards by it. */
  nearest?: { which: 'depart' | 'arrive'; window: { earliest?: string; latest?: string } };
} {
  for (const k of RELAX_ORDER.filter((key) => Boolean(filters[key]))) {
    const rest: RefineFilters = { ...filters, [k]: undefined };
    const pool = applyFilters(all, rest);
    if (pool.length) {
      const closest = closestTo(pool, filters, k);
      const nearest =
        k === 'departWindow'
          ? { which: 'depart' as const, window: filters.departWindow! }
          : k === 'arriveWindow'
            ? { which: 'arrive' as const, window: filters.arriveWindow! }
            : undefined;
      return { pool: closest, note: relaxNote(k, filters, rest, closest, all), nearest };
    }
  }
  // Nothing survives dropping any single constraint: show what is nearest overall.
  const miss = (o: FlightOffer) =>
    (filters.departWindow ? windowMiss(departMinutes(o.outbound), filters.departWindow) : 0) +
    (filters.arriveWindow ? windowMiss(arrivalMinutes(o.outbound), filters.arriveWindow) : 0) +
    (filters.nonStopOnly ? o.outbound.stops * 60 : 0);
  const pool = [...all].sort((a, b) => miss(a) - miss(b)).slice(0, 6);
  return {
    pool,
    note: `Nothing is *${describeFilters(filters)}* on this date, so here are the closest I have 👇`,
  };
}

/** For a time window that couldn't be met, the flights nearest to it — not a random three. */
function closestTo(pool: FlightOffer[], filters: RefineFilters, dropped: Relaxable): FlightOffer[] {
  const w = dropped === 'departWindow' ? filters.departWindow : dropped === 'arriveWindow' ? filters.arriveWindow : null;
  if (!w) return pool;
  const time = (o: FlightOffer) =>
    dropped === 'departWindow' ? departMinutes(o.outbound) : arrivalMinutes(o.outbound);
  const ranked = [...pool].sort((a, b) => windowMiss(time(a), w) - windowMiss(time(b), w));
  const best = windowMiss(time(ranked[0]), w);
  return ranked.filter((o, i) => i < 3 || windowMiss(time(o), w) <= best + 90).slice(0, 6);
}

function relaxNote(
  dropped: Relaxable,
  filters: RefineFilters,
  rest: RefineFilters,
  pool: FlightOffer[],
  all: FlightOffer[],
): string {
  const restDesc = describeFilters(rest);
  switch (dropped) {
    case 'maxPrice': {
      const cheapest = Math.min(...pool.map((o) => o.price.total));
      return restDesc
        ? `Nothing under ${formatINR(filters.maxPrice!)} is also *${restDesc}* — the closest fare is ${formatINR(cheapest)} 👇`
        : `Nothing under ${formatINR(filters.maxPrice!)} on this route — the closest I have is ${formatINR(cheapest)}.`;
    }
    case 'nonStopOnly': {
      const nonStops = all.filter((o) => o.outbound.stops === 0);
      if (!nonStops.length) return 'There are no non-stop flights on this route that day — these have the fewest stops 👇';
      if (!restDesc) return 'No non-stop fits — these have the fewest stops 👇';
      return `No non-stop flight is *${restDesc}* that day${nonStopHint(nonStops, rest)}. These have a stop but are *${restDesc}* 👇`;
    }
    case 'departWindow':
      return (
        `Nothing departs ${describeWindow(filters.departWindow!)}${restDesc ? ` and is also *${restDesc}*` : ''} — ` +
        `here are the nearest departure times 👇`
      );
    case 'arriveWindow': {
      const soonest = pool[0] ? clockTime(arrivalMinutes(pool[0].outbound)) : null;
      return (
        `Nothing${restDesc ? ` *${restDesc}*` : ''} lands ${describeWindow(filters.arriveWindow!)} that day` +
        `${soonest ? ` — the closest lands at ${soonest}` : ''}. Here are the nearest 👇`
      );
    }
  }
}

/** The single most useful fact about the non-stops the user can't have. */
function nonStopHint(nonStops: FlightOffer[], rest: RefineFilters): string {
  if (rest.arriveWindow) {
    const w = rest.arriveWindow;
    const best = [...nonStops].sort(
      (a, b) => windowMiss(arrivalMinutes(a.outbound), w) - windowMiss(arrivalMinutes(b.outbound), w),
    )[0];
    return ` (the nearest non-stop lands at ${clockTime(arrivalMinutes(best.outbound))})`;
  }
  if (rest.departWindow) {
    const w = rest.departWindow;
    const best = [...nonStops].sort(
      (a, b) => windowMiss(departMinutes(a.outbound), w) - windowMiss(departMinutes(b.outbound), w),
    )[0];
    return ` (the nearest non-stop leaves at ${clockTime(departMinutes(best.outbound))})`;
  }
  return '';
}

// ── selection & refinement ───────────────────────────────────────────────────

async function awaitingSelection(session: SessionRecord, d: TurnDecision, ctx: TurnCtx): Promise<string[]> {
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
    if (!missingTripSlots(session.slots.trip).length) return runSearch(session, ctx);
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
  if (refinement.applied.length) return presentOptions(session, { applied: refinement.applied });

  const shown = session.slots.pickIds?.length ?? 3;
  if (refinement.restated) {
    // They asked for what is already applied — say so, rather than answering
    // a clear request with a generic "reply 1, 2 or 3".
    const active = describeFilters(session.slots.activeFilters ?? {});
    return [
      active
        ? `✅ Already done — the options above are all *${active}*.\n${replyHint(shown)}`
        : `You're already seeing every flight I found.\n${replyHint(shown)}`,
    ];
  }

  // An address typed while choosing is the one the itinerary should go to.
  // Keep it, so the passenger step doesn't ask for it again.
  const email = extractEmail(ctx.text);
  if (email) {
    session.slots.draftPassenger.email = email;
    return [`📧 Noted — I'll send the itinerary to ${email}.\nNow pick your flight: ${pickPrompt(shown)}.`];
  }

  if (d.intent === 'GREET') return [welcomeBack(session)];
  if (d.intent === 'CONFIRM') {
    // "yes" with a single option on screen can only mean that one.
    if (shown === 1) return selectOption(session, 1);
    return [`Which one — ${pickPrompt(shown)}?`];
  }
  if (d.intent === 'DENY') {
    return ['No problem. Tell me what to change — a time, date, price or stops — or say *start over* for a new trip.'];
  }
  return [clarify(session, d)];
}

/** "Hi" in the middle of a search: remind them where they are, in one breath. */
function welcomeBack(session: SessionRecord): string {
  const t = session.slots.trip;
  const date = t.departDate ? ` on ${DateTime.fromISO(t.departDate).toFormat('ccc d LLL')}` : '';
  const active = describeFilters(session.slots.activeFilters ?? {});
  return (
    `Hi again 👋 We were looking at *${t.origin} → ${t.destination}*${date}${active ? ` (${active})` : ''}.\n` +
    `${replyHint(session.slots.pickIds?.length ?? 3)}\nOr say *start over* for a new trip.`
  );
}

/**
 * The answer to a message the engine could not act on. The model's own reply
 * is used when there is one and it passes the fact check; otherwise the user
 * gets concrete examples of what they *can* say here, not a shrug.
 */
function clarify(session: SessionRecord, d: TurnDecision): string {
  const modelReply = usableModelReply(session, d);
  if (modelReply) return modelReply;

  switch (session.state) {
    case 'AWAITING_SELECTION':
      return (
        `Sorry, I didn't quite get that 🤔 I can narrow these down by landing or departure time ` +
        `("land before 11am", "leave after 6pm"), stops ("non-stop"), price ("under 8k") or date ` +
        `("Friday instead") — or ${pickPrompt(session.slots.pickIds?.length ?? 3)} to book.`
      );
    case 'COLLECTING_PASSENGER':
      return nextPassengerPrompt(session) ?? 'Could you send that again?';
    case 'CONFIRMING':
      return `Just say *yes* and I'll issue it, or *no* to change something.`;
    case 'COMPLETED':
      return 'Want me to look at another trip, or anything about baggage or check-in?';
    default: {
      const missing = missingTripSlots(session.slots.trip);
      return missing.length ? askFor(session, missing) : 'Where are you flying from, and where to?';
    }
  }
}

function usableModelReply(session: SessionRecord, d: TurnDecision): string | null {
  if (!d.reply || d.source === 'rules' || d.reply.length > 700) return null;
  // Checked here rather than left to reply(): a model reply that quotes a fare
  // it wasn't given should fall back to the plain answer, not open a ticket.
  const amounts = [session.slots.trip.budgetMax].filter((n): n is number => typeof n === 'number');
  if (!verifyOutbound(d.reply, session.offers, amounts).ok) {
    log.warn('model reply failed the fact check — using the deterministic answer');
    return null;
  }
  return d.reply;
}

/** After "shall I carry on?" → "yes": pick up exactly where the trip was. */
async function resumeWhereWeWere(session: SessionRecord, ctx: TurnCtx): Promise<string[]> {
  switch (session.state) {
    case 'AWAITING_SELECTION':
    case 'PRESENTING_OPTIONS':
    case 'SEARCHING':
      if (session.offers?.length) return presentOptions(session, { lead: "Great — here's where we left off 👇" });
      break;
    case 'COLLECTING_PASSENGER':
      return [nextPassengerPrompt(session) ?? 'Now your details, please.'];
    case 'COMPLETED':
      return ['Great — where would you like to go next?'];
  }
  const missing = missingTripSlots(session.slots.trip);
  if (!missing.length) return runSearch(session, ctx);
  session.state = 'COLLECTING_TRIP';
  return [askFor(session, missing)];
}

const PREFERENCES = ['CHEAPEST', 'FASTEST', 'BEST_VALUE', 'COMFORT'] as const;

/**
 * Apply whatever the message changes about the filters. `applied` lists the
 * real changes; `restated` means the user asked for something already in
 * force — both deserve a different answer from "didn't understand".
 */
function collectRefinement(session: SessionRecord, d: TurnDecision): { applied: string[]; restated: boolean } {
  const filters = { ...(session.slots.activeFilters ?? {}) };
  const t = session.slots.trip;
  const applied: string[] = [];
  let mentioned = false;

  const args = (d.args ?? {}) as Record<string, unknown>;

  if (d.flags.clearFilters || args.reset === true) {
    mentioned = true;
    if (describeFilters(filters)) applied.push('all flights, no filters');
    filters.nonStopOnly = undefined;
    filters.maxPrice = undefined;
    filters.departWindow = undefined;
    filters.arriveWindow = undefined;
    filters.carrier = undefined;
    t.nonStopOnly = undefined;
    t.budgetMax = undefined;
    t.departWindow = undefined;
    t.arriveWindow = undefined;
  }

  const preference = d.trip.preference ?? args.preference;
  const src = {
    nonStopOnly: d.trip.nonStopOnly ?? (typeof args.nonStopOnly === 'boolean' ? args.nonStopOnly : undefined),
    maxPrice: d.trip.budgetMax ?? (typeof args.maxPrice === 'number' ? args.maxPrice : undefined),
    preference: PREFERENCES.includes(preference as (typeof PREFERENCES)[number])
      ? (preference as (typeof PREFERENCES)[number])
      : undefined,
    departWindow: d.trip.departWindow ?? timeWindow(args.departWindow),
    arriveWindow: d.trip.arriveWindow ?? timeWindow(args.arriveWindow),
  };

  // Only report what actually changed. The model likes to restate slots it was
  // not asked about ("stops allowed" when the user only said "cheaper"), and
  // echoing those back reads like the bot misheard.
  // `undefined` and `false` both mean "no non-stop filter", so a model that
  // helpfully restates nonStopOnly:false is not a change worth announcing.
  if (src.nonStopOnly !== undefined) {
    mentioned ||= src.nonStopOnly;
    if (Boolean(src.nonStopOnly) !== Boolean(filters.nonStopOnly)) {
      filters.nonStopOnly = src.nonStopOnly;
      t.nonStopOnly = src.nonStopOnly;
      applied.push(src.nonStopOnly ? 'non-stop only' : 'stops allowed');
    }
  }
  if (src.maxPrice !== undefined) {
    mentioned = true;
    if (src.maxPrice !== filters.maxPrice) {
      filters.maxPrice = src.maxPrice;
      t.budgetMax = src.maxPrice;
      applied.push(`under ${formatINR(src.maxPrice)}`);
    }
  }
  if (src.preference !== undefined) {
    mentioned = true;
    if (src.preference !== filters.preference) {
      filters.preference = src.preference;
      t.preference = src.preference;
      applied.push(src.preference === 'CHEAPEST' ? 'cheapest first' : src.preference.toLowerCase().replace('_', ' '));
    }
  }
  if (src.departWindow !== undefined) {
    mentioned = true;
    if (!sameWindow(src.departWindow, filters.departWindow)) {
      filters.departWindow = src.departWindow;
      t.departWindow = src.departWindow;
      applied.push(`departing ${describeWindow(src.departWindow)}`);
    }
  }
  if (src.arriveWindow !== undefined) {
    mentioned = true;
    if (!sameWindow(src.arriveWindow, filters.arriveWindow)) {
      filters.arriveWindow = src.arriveWindow;
      t.arriveWindow = src.arriveWindow;
      applied.push(`landing ${describeWindow(src.arriveWindow)}`);
    }
  }

  if (!applied.length) return { applied, restated: mentioned };

  session.slots.activeFilters = filters;
  void getStore().insertEvent({
    sessionId: session.id,
    type: 'search_refined',
    payload: { filters: applied },
  });
  return { applied, restated: false };
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
  if (!offer) return [`There's no option ${index} on the list — ${pickPrompt(ids.length || 3)} and I'll lock it in.`];

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
  const label = session.slots.pickLabels?.[picks.indexOf(offer.id)] ?? 'BEST_VALUE';
  const pick: RankedPick = { label, offer, score: 0, whyThisOne: '' };
  return selectionMessage(pick, session.slots.trip);
}

// ── passenger collection ─────────────────────────────────────────────────────

async function collectPassenger(session: SessionRecord, d: TurnDecision): Promise<string[]> {
  if (d.intent === 'DENY' && !Object.values(d.passenger).some(Boolean)) {
    session.state = 'AWAITING_SELECTION';
    return presentOptions(session, { lead: 'No problem — here are your options again 👇' });
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
    return presentOptions(session, { lead: 'No problem — nothing has been booked. Here are the options again 👇' });
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

async function completed(session: SessionRecord, d: TurnDecision, ctx: TurnCtx): Promise<string[]> {
  if (d.trip.origin || d.trip.destination || d.trip.departDate) {
    const ref = session.slots.bookingRef;
    resetTrip(session);
    withTripDefaults(session);
    const ambiguity = mergeTripInto(session, d);
    if (ambiguity) return [ambiguity];
    const missing = missingTripSlots(session.slots.trip);
    const lead = ref ? `Sure — ${ref} is all set. New trip:` : 'Sure —';
    if (!missing.length) return runSearch(session, ctx);
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

/**
 * The user was asked for an email so the agent could write to them. If this
 * message has one, send the handoff email and let the bot carry on with the
 * parts of the trip it can still do. The ticket stays open for the human.
 *
 * Returns true when the turn is finished here.
 */
async function completePendingHandoff(
  session: SessionRecord,
  channel: Channel,
  text: string,
): Promise<boolean> {
  const pending = session.slots.pendingHandoffEmail!;
  const email = extractEmail(text);

  if (!email) {
    // Don't nag. One reminder, then the SLA sweeper takes over.
    if (/\b(no|skip|later|don'?t|nevermind|never mind)\b/i.test(text)) {
      session.slots.pendingHandoffEmail = undefined;
      session.control = 'BOT';
      session.state = resumeStateFor(session);
      session.slots.offeredToResume = true;
      await saveSession(session);
      await channel.send(
        session.channelUserId,
        `No problem — I've kept ticket *${pending.ticket}* open and our team has the details.\n` +
          `Shall we carry on with your trip?`,
      );
      return true;
    }
    // Someone who asked for a person is waiting for one: their message goes to
    // the agent. But when it was the *bot* that handed off, a user who just
    // carries on with their trip should get the bot back, not silence — the
    // ticket stays open for the human either way.
    if (pending.reason !== 'USER_REQUESTED_HUMAN') {
      session.slots.pendingHandoffEmail = undefined;
      session.control = 'BOT';
      session.state = resumeStateFor(session);
    }
    return false; // not an email and not a refusal — fall through to normal handling
  }

  // Remember it, so the booking flow doesn't ask for the same address again.
  session.slots.draftPassenger.email ??= email;

  const sent = await sendAgentHandoffEmail({
    session,
    ticket: pending.ticket,
    reason: pending.reason,
    to: email,
    userQuestion: pending.userQuestion,
  });

  session.slots.pendingHandoffEmail = undefined;
  session.control = 'BOT';
  session.state = resumeStateFor(session);
  session.slots.offeredToResume = true;
  await saveSession(session);

  await channel.send(
    session.channelUserId,
    sent
      ? `✅ Done — *${config.AGENT_NAME}* from our customer care team has just emailed you at ${email} ` +
          `about ticket *${pending.ticket}*. Reply straight to that email and it reaches them.\n\n` +
          `I can carry on helping with your trip here in the meantime — want me to?`
      : // Never claim an email was sent when it wasn't.
        `I couldn't get an email through to ${email} just now — ticket *${pending.ticket}* is still open ` +
          `and our team has your details, so they'll reach you here on WhatsApp.\n\n` +
          `I can carry on helping with your trip here in the meantime — want me to?`,
  );
  return true;
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
