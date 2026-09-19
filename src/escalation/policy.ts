import type { EscalationReason } from '../db/types.js';
import type { Intent } from '../llm/rules-fallback.js';

/**
 * When to stop talking and fetch a human. Pure, deterministic and heavily
 * tested (tests/escalation-policy.test.ts) — this is a policy, not a vibe, and
 * it must behave identically whether or not the LLM is reachable.
 */

export const LOW_CONFIDENCE_THRESHOLD = 0.55;
export const HIGH_VALUE_THRESHOLD = 150_000;
export const MAX_GROUP_SIZE = 9;

export interface PolicyInput {
  text: string;
  intent: Intent;
  confidence: number;
  /** Consecutive low-confidence turns BEFORE this one. */
  lowConfidenceStreak: number;
  /** Corrections seen in the last three turns. */
  recentCorrections: number;
  /** An adjacent question was asked and the knowledge base had no answer. */
  kbMiss: boolean;
  /** Search, LLM or email failed after its retries. */
  providerFailure: boolean;
  quoteTotal?: number;
  paxCount?: number;
  alreadyEscalated: boolean;
}

export interface PolicyDecision {
  escalate: boolean;
  reason?: EscalationReason;
  detail?: string;
}

const POLICY_SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b(refund|charge ?back|money back|reimburse)\b/i, 'refund request'],
  [/\b(medical|wheelchair|oxygen|stretcher|pregnan\w+|disab\w+|assistance)\b/i, 'medical or accessibility need'],
  [/\b(unaccompanied minor|child (travelling|traveling|flying) alone|kid alone|umnr)\b/i, 'unaccompanied minor'],
  [/\b(visa|immigration|deport\w*|entry (requirement|permit)|eligib\w+ to (enter|travel))\b/i, 'visa or immigration eligibility'],
  [/\b(pet|animal|dog|cat) (travel|in cabin|cargo)\b/i, 'pet travel'],
  [/\b(corporate|gst invoice|group booking|bulk booking)\b/i, 'group or corporate booking'],
];

const NEGATIVE_PATTERNS =
  /\b(useless|stupid|terrible|awful|rubbish|ridiculous|frustrat\w*|annoy\w*|angry|fed up|waste of (my )?time|not working|you (don'?t|dont) understand|i already (said|told)|for the (third|3rd|last) time)\b|[!?]{3,}/i;

const HUMAN_PATTERNS =
  /\b(human|agent|real person|representative|customer (care|service|support)|talk to (someone|a person|somebody)|speak to (someone|a person|somebody)|escalate|supervisor|manager)\b/i;

export function evaluateEscalation(input: PolicyInput): PolicyDecision {
  // Never stack tickets on a conversation that already has one open.
  if (input.alreadyEscalated) return { escalate: false };

  if (input.intent === 'REQUEST_HUMAN' || HUMAN_PATTERNS.test(input.text)) {
    return { escalate: true, reason: 'USER_REQUESTED_HUMAN', detail: 'the user asked for a person' };
  }

  if (input.providerFailure) {
    return {
      escalate: true,
      reason: 'PROVIDER_FAILURE',
      detail: 'a search, model or email call failed after its retries',
    };
  }

  for (const [re, label] of POLICY_SENSITIVE_PATTERNS) {
    if (re.test(input.text)) {
      return { escalate: true, reason: 'POLICY_SENSITIVE', detail: label };
    }
  }

  if ((input.paxCount ?? 0) > MAX_GROUP_SIZE) {
    return {
      escalate: true,
      reason: 'POLICY_SENSITIVE',
      detail: `group of ${input.paxCount} — above the ${MAX_GROUP_SIZE}-passenger self-service limit`,
    };
  }

  if ((input.quoteTotal ?? 0) > HIGH_VALUE_THRESHOLD) {
    return {
      escalate: true,
      reason: 'HIGH_VALUE',
      detail: `quote of ₹${Math.round(input.quoteTotal!).toLocaleString('en-IN')} is above the review threshold`,
    };
  }

  if (input.intent === 'OUT_OF_SCOPE') {
    return { escalate: true, reason: 'OUT_OF_SCOPE', detail: 'request is outside flights and booking' };
  }

  if (input.kbMiss) {
    return { escalate: true, reason: 'KNOWLEDGE_GAP', detail: 'adjacent question with no knowledge-base match' };
  }

  if (NEGATIVE_PATTERNS.test(input.text) || input.recentCorrections >= 2) {
    return {
      escalate: true,
      reason: 'NEGATIVE_SENTIMENT',
      detail: NEGATIVE_PATTERNS.test(input.text) ? 'frustration in the message' : 'repeated corrections',
    };
  }

  // Two consecutive turns we could not read. One is a misunderstanding; two is a pattern.
  if (input.confidence < LOW_CONFIDENCE_THRESHOLD && input.lowConfidenceStreak >= 1) {
    return {
      escalate: true,
      reason: 'LOW_CONFIDENCE_REPEATED',
      detail: `two consecutive turns below ${LOW_CONFIDENCE_THRESHOLD} confidence`,
    };
  }

  return { escalate: false };
}

/** Streak bookkeeping, kept next to the threshold it depends on. */
export function nextLowConfidenceStreak(current: number, confidence: number): number {
  return confidence < LOW_CONFIDENCE_THRESHOLD ? current + 1 : 0;
}

export function isWithinBusinessHours(
  now: Date,
  hours: { open: string; close: string },
  timeZone: string,
): boolean {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = fmt.format(now).split(':').map(Number);
  const mins = h * 60 + m;
  const toMin = (s: string) => {
    const [hh, mm] = s.split(':').map(Number);
    return hh * 60 + mm;
  };
  const open = toMin(hours.open);
  const close = toMin(hours.close);
  return open <= close ? mins >= open && mins < close : mins >= open || mins < close;
}
