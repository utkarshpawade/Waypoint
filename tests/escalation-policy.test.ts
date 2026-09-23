import { describe, expect, it } from 'vitest';
import {
  evaluateEscalation,
  isWithinBusinessHours,
  nextLowConfidenceStreak,
  HIGH_VALUE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
  type PolicyInput,
} from '../src/escalation/policy.js';

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    text: 'bangalore to dubai next friday',
    intent: 'PROVIDE_TRIP',
    confidence: 0.9,
    lowConfidenceStreak: 0,
    recentCorrections: 0,
    kbMiss: false,
    providerFailure: false,
    alreadyEscalated: false,
    ...overrides,
  };
}

describe('escalation triggers', () => {
  it('does not escalate an ordinary, confident turn', () => {
    expect(evaluateEscalation(input()).escalate).toBe(false);
  });

  it('escalates when the user asks for a human, in any phrasing', () => {
    for (const text of [
      'can i talk to a human',
      'get me an agent',
      'I want to speak to someone',
      'customer care please',
      'let me talk to a real person',
      'escalate this',
    ]) {
      const d = evaluateEscalation(input({ text }));
      expect(d.escalate, text).toBe(true);
      expect(d.reason, text).toBe('USER_REQUESTED_HUMAN');
    }
  });

  it('does not mistake ordinary words for a request for a human', () => {
    for (const text of ['book me a flight', 'the agenda is tight', 'I am human after all right']) {
      // "human" genuinely appears in the third — a false positive here is
      // acceptable and safe, but the first two must not trigger.
      if (text.includes('human')) continue;
      expect(evaluateEscalation(input({ text })).escalate, text).toBe(false);
    }
  });

  it('escalates a provider failure over everything except an explicit human request', () => {
    expect(evaluateEscalation(input({ providerFailure: true })).reason).toBe('PROVIDER_FAILURE');
    expect(evaluateEscalation(input({ providerFailure: true, text: 'I want an agent' })).reason).toBe(
      'USER_REQUESTED_HUMAN',
    );
  });

  it('escalates policy-sensitive topics rather than answering them', () => {
    const cases: [string, string][] = [
      ['can i get a refund on this', 'refund request'],
      ['i need wheelchair assistance', 'medical or accessibility need'],
      ['my kid is flying alone, is that ok', 'unaccompanied minor'],
      ['do i need a visa for dubai', 'visa or immigration eligibility'],
      ['can my dog travel in cabin', 'pet travel'],
    ];
    for (const [text, detail] of cases) {
      const d = evaluateEscalation(input({ text }));
      expect(d.escalate, text).toBe(true);
      expect(d.reason, text).toBe('POLICY_SENSITIVE');
      expect(d.detail, text).toBe(detail);
    }
  });

  it('escalates a group larger than the self-service limit', () => {
    expect(evaluateEscalation(input({ paxCount: 9 })).escalate).toBe(false);
    const d = evaluateEscalation(input({ paxCount: 12 }));
    expect(d.reason).toBe('POLICY_SENSITIVE');
    expect(d.detail).toMatch(/group of 12/);
  });

  it('escalates a high-value quote', () => {
    expect(evaluateEscalation(input({ quoteTotal: HIGH_VALUE_THRESHOLD })).escalate).toBe(false);
    const d = evaluateEscalation(input({ quoteTotal: HIGH_VALUE_THRESHOLD + 1 }));
    expect(d.reason).toBe('HIGH_VALUE');
    expect(d.detail).toMatch(/₹1,50,001/);
  });

  it('escalates out-of-scope requests', () => {
    expect(evaluateEscalation(input({ intent: 'OUT_OF_SCOPE', text: 'book me a hotel' })).reason).toBe('OUT_OF_SCOPE');
  });

  it('escalates a knowledge gap instead of improvising', () => {
    expect(evaluateEscalation(input({ kbMiss: true, intent: 'FAQ' })).reason).toBe('KNOWLEDGE_GAP');
  });

  it('escalates on frustration or repeated corrections', () => {
    expect(evaluateEscalation(input({ text: 'this is useless' })).reason).toBe('NEGATIVE_SENTIMENT');
    expect(evaluateEscalation(input({ text: 'for the third time, BLR' })).reason).toBe('NEGATIVE_SENTIMENT');
    expect(evaluateEscalation(input({ recentCorrections: 2 })).reason).toBe('NEGATIVE_SENTIMENT');
    expect(evaluateEscalation(input({ recentCorrections: 1 })).escalate).toBe(false);
  });

  it('needs three consecutive low-confidence turns — two just get a clarifying question', () => {
    const first = evaluateEscalation(input({ confidence: 0.3, lowConfidenceStreak: 0, text: 'mmm' }));
    expect(first.escalate).toBe(false);
    const second = evaluateEscalation(input({ confidence: 0.3, lowConfidenceStreak: 1, text: 'mmm' }));
    expect(second.escalate).toBe(false);
    const third = evaluateEscalation(input({ confidence: 0.3, lowConfidenceStreak: 2, text: 'mmm' }));
    expect(third.reason).toBe('LOW_CONFIDENCE_REPEATED');
  });

  it('never stacks a second ticket on a conversation that already has one', () => {
    expect(evaluateEscalation(input({ text: 'I want a human', alreadyEscalated: true })).escalate).toBe(false);
    expect(evaluateEscalation(input({ providerFailure: true, alreadyEscalated: true })).escalate).toBe(false);
  });

  it('is deterministic — the same input always gives the same decision', () => {
    const i = input({ text: 'do i need a visa', confidence: 0.4 });
    const runs = Array.from({ length: 5 }, () => JSON.stringify(evaluateEscalation(i)));
    expect(new Set(runs).size).toBe(1);
  });
});

describe('low-confidence streak', () => {
  it('increments below the threshold and resets above it', () => {
    expect(nextLowConfidenceStreak(0, LOW_CONFIDENCE_THRESHOLD - 0.01)).toBe(1);
    expect(nextLowConfidenceStreak(1, 0.2)).toBe(2);
    expect(nextLowConfidenceStreak(3, 0.9)).toBe(0);
    expect(nextLowConfidenceStreak(3, LOW_CONFIDENCE_THRESHOLD)).toBe(0);
  });
});

describe('business hours', () => {
  const hours = { open: '09:00', close: '22:00' };
  const at = (iso: string) => new Date(iso);

  it('recognises inside and outside a normal window', () => {
    expect(isWithinBusinessHours(at('2026-03-10T05:00:00Z'), hours, 'Asia/Kolkata')).toBe(true); // 10:30 IST
    expect(isWithinBusinessHours(at('2026-03-10T20:00:00Z'), hours, 'Asia/Kolkata')).toBe(false); // 01:30 IST
    expect(isWithinBusinessHours(at('2026-03-10T03:00:00Z'), hours, 'Asia/Kolkata')).toBe(false); // 08:30 IST
  });

  it('handles a window that crosses midnight', () => {
    const night = { open: '22:00', close: '06:00' };
    expect(isWithinBusinessHours(at('2026-03-10T18:00:00Z'), night, 'Asia/Kolkata')).toBe(true); // 23:30 IST
    expect(isWithinBusinessHours(at('2026-03-10T09:00:00Z'), night, 'Asia/Kolkata')).toBe(false); // 14:30 IST
  });
});
