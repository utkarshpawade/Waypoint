import { DateTime } from 'luxon';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { llm } from '../llm/client.js';
import { interpretRules, isPastDate, type Intent, type RulesResult } from '../llm/rules-fallback.js';
import { getAirport } from '../flights/airports.js';
import type { EscalationReason, PassengerDraft, SessionRecord, TripSlots } from '../db/types.js';
import { contextBlock, stateGuidanceFor, systemPrompt } from './prompts.js';
import { isToolName, type ToolName } from './tools.js';

const log = logger.child({ mod: 'interpret' });

/**
 * The model is on the critical path of a WhatsApp reply. Past this, the rules
 * answer alone — a slightly dumber reply now beats a perfect one never.
 */
const LLM_DEADLINE_MS = 9_000;

export interface TurnDecision {
  intent: Intent;
  confidence: number;
  trip: Partial<TripSlots>;
  passenger: PassengerDraft;
  selection?: number;
  tool?: ToolName;
  args?: Record<string, unknown>;
  reply?: string;
  escalate?: { reason: EscalationReason; note?: string };
  ambiguousPlaces: RulesResult['ambiguousPlaces'];
  flags: RulesResult['flags'];
  source: 'llm' | 'rules' | 'llm+rules';
}

interface LlmShape {
  intent?: string;
  confidence?: number;
  slots?: Record<string, unknown>;
  passenger?: Record<string, unknown>;
  tool?: string | null;
  args?: Record<string, unknown>;
  reply?: string | null;
  escalate?: { reason?: string; note?: string } | null;
}

const VALID_INTENTS: Intent[] = [
  'GREET', 'PROVIDE_TRIP', 'REFINE', 'SELECT', 'PROVIDE_PASSENGER', 'CONFIRM',
  'DENY', 'FAQ', 'OUT_OF_SCOPE', 'REQUEST_HUMAN', 'RESTART', 'UNKNOWN',
];

/**
 * One turn of interpretation.
 *
 * The rules engine always runs. The LLM runs on top of it when available, and
 * may add intent nuance, fill slots the regexes missed, and propose a tool —
 * but it can never override a date or a city, because those are arithmetic and
 * a lookup table, and a model that gets them wrong books the wrong flight.
 */
export async function interpretTurn(
  session: SessionRecord,
  text: string,
  history: { author: string; body: string }[],
): Promise<TurnDecision> {
  // The inbound message is already stored, so it is the last history entry.
  // Sending it twice makes the model think the user repeated themselves.
  const last = history.at(-1);
  const prior = last && last.author === 'USER' && last.body === text ? history.slice(0, -1) : history;

  const rules = interpretRules(text, {
    state: session.state,
    expectingPassenger: session.state === 'COLLECTING_PASSENGER' || session.state === 'CONFIRMING',
    hasOffers: Boolean(session.offers?.length),
  });

  const decision: TurnDecision = {
    intent: rules.intent,
    confidence: rules.confidence,
    trip: rules.trip,
    passenger: rules.passenger,
    selection: rules.selection,
    ambiguousPlaces: rules.ambiguousPlaces,
    flags: rules.flags,
    source: 'rules',
  };

  if (!llm.available()) return decision;

  try {
    const messages = [
      { role: 'system' as const, content: systemPrompt(session, stateGuidanceFor(session.state)) },
      { role: 'system' as const, content: contextBlock(session) },
      ...prior.slice(-8).map((m) => ({
        role: (m.author === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body,
      })),
      { role: 'user' as const, content: text },
    ];
    const raw = await llm.chatJson<LlmShape>(messages, { deadlineMs: LLM_DEADLINE_MS });
    if (!raw) return decision;
    return mergeLlm(decision, raw, rules, text);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'llm interpretation unavailable — using rules only');
    return decision;
  }
}

export function mergeLlm(base: TurnDecision, raw: LlmShape, rules: RulesResult, userText = ''): TurnDecision {
  const out: TurnDecision = { ...base, source: 'llm+rules' };

  if (typeof raw.intent === 'string' && VALID_INTENTS.includes(raw.intent as Intent)) {
    // The rules engine wins on the two intents it detects with certainty:
    // an explicit request for a human, and a numbered selection.
    const rulesCertain = rules.intent === 'REQUEST_HUMAN' || (rules.intent === 'SELECT' && rules.selection);
    if (!rulesCertain) out.intent = raw.intent as Intent;
  }

  if (typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1) {
    // The model reads free text far better than the regexes do, so its own
    // confidence stands. Capping it at the rules' level (as this once did)
    // meant every sentence the regexes missed counted as "unreadable", and two
    // in a row escalated a perfectly clear request to a human.
    out.confidence = raw.confidence;
    if (rules.intent === 'REQUEST_HUMAN' || rules.selection) out.confidence = base.confidence;
  }

  out.trip = mergeTrip(rules.trip, raw.slots ?? {}, userText);
  out.passenger = mergePassenger(rules.passenger, raw.passenger ?? {});

  if (raw.tool && isToolName(raw.tool)) {
    out.tool = raw.tool;
    out.args = (raw.args ?? {}) as Record<string, unknown>;
  }

  if (typeof raw.reply === 'string' && raw.reply.trim()) out.reply = raw.reply.trim();

  if (raw.escalate?.reason) {
    out.escalate = {
      reason: raw.escalate.reason as EscalationReason,
      note: raw.escalate.note,
    };
  }

  return out;
}

/**
 * Rules-first merge. The model may only contribute a slot the regexes missed,
 * and only if it survives validation — an unknown IATA code or a date in the
 * past is dropped, not asked about.
 */
export function mergeTrip(
  rulesTrip: Partial<TripSlots>,
  llmSlots: Record<string, unknown>,
  userText = '',
): Partial<TripSlots> {
  const out: Partial<TripSlots> = { ...rulesTrip };

  for (const key of ['origin', 'destination'] as const) {
    if (out[key]) continue;
    const v = llmSlots[key];
    if (typeof v === 'string' && getAirport(v)) out[key] = v.toUpperCase();
  }

  for (const key of ['departDate', 'returnDate'] as const) {
    if (out[key]) continue;
    const v = llmSlots[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = DateTime.fromISO(v, { zone: config.BUSINESS_TZ });
      if (d.isValid && !isPastDate(v)) out[key] = v;
    }
  }

  for (const key of ['adults', 'children', 'infants'] as const) {
    if (out[key] !== undefined) continue;
    const v = llmSlots[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9) out[key] = v;
  }

  if (out.cabin === undefined && typeof llmSlots.cabin === 'string') {
    const c = llmSlots.cabin.toUpperCase();
    if (['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(c)) out.cabin = c as TripSlots['cabin'];
  }
  if (out.preference === undefined && typeof llmSlots.preference === 'string') {
    const p = llmSlots.preference.toUpperCase();
    if (['CHEAPEST', 'FASTEST', 'BEST_VALUE', 'COMFORT'].includes(p)) out.preference = p as TripSlots['preference'];
  }
  // A budget is a number the user said. Asked for "anything cheaper", a model
  // will happily invent a ceiling — and the bot would then honestly report that
  // nothing meets a limit the user never set. If there is no digit in their
  // message, there is no budget.
  if (
    out.budgetMax === undefined &&
    typeof llmSlots.budgetMax === 'number' &&
    llmSlots.budgetMax > 500 &&
    /\d/.test(userText)
  ) {
    out.budgetMax = Math.round(llmSlots.budgetMax);
  }
  if (out.nonStopOnly === undefined && typeof llmSlots.nonStopOnly === 'boolean') {
    out.nonStopOnly = llmSlots.nonStopOnly;
  }
  for (const key of ['departWindow', 'arriveWindow'] as const) {
    if (out[key] !== undefined) continue;
    const w = timeWindow(llmSlots[key]);
    if (w) out[key] = w;
  }
  if (out.tripType === undefined && (out.returnDate || llmSlots.returnDate)) out.tripType = 'ROUND_TRIP';

  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A model-supplied {earliest, latest} survives only if its times are real HH:mm. */
export function timeWindow(v: unknown): { earliest?: string; latest?: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { earliest, latest } = v as Record<string, unknown>;
  const w: { earliest?: string; latest?: string } = {};
  if (typeof earliest === 'string' && HHMM.test(earliest)) w.earliest = earliest;
  if (typeof latest === 'string' && HHMM.test(latest)) w.latest = latest;
  return w.earliest || w.latest ? w : undefined;
}

export function mergePassenger(rulesDraft: PassengerDraft, llmDraft: Record<string, unknown>): PassengerDraft {
  const out: PassengerDraft = { ...rulesDraft };
  const strings = ['fullName', 'email', 'phone', 'passportNo', 'nationality'] as const;
  for (const key of strings) {
    if (out[key]) continue;
    const v = llmDraft[key];
    if (typeof v === 'string' && v.trim().length >= 2) out[key] = v.trim();
  }
  for (const key of ['dateOfBirth', 'passportExpiry'] as const) {
    if (out[key]) continue;
    const v = llmDraft[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[key] = v;
  }
  if (!out.gender && typeof llmDraft.gender === 'string' && ['M', 'F', 'X'].includes(llmDraft.gender.toUpperCase())) {
    out.gender = llmDraft.gender.toUpperCase() as PassengerDraft['gender'];
  }
  return out;
}
