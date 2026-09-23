import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { mergeLlm, mergeTrip, timeWindow, type TurnDecision } from '../src/conversation/interpret.js';
import { interpretRules } from '../src/llm/rules-fallback.js';

const NOW = DateTime.fromISO('2026-09-19T14:00:00', { zone: 'Asia/Kolkata' });

function baseFor(text: string, state = 'AWAITING_SELECTION') {
  const rules = interpretRules(text, { state, hasOffers: true }, NOW);
  const base: TurnDecision = {
    intent: rules.intent,
    confidence: rules.confidence,
    trip: rules.trip,
    passenger: rules.passenger,
    selection: rules.selection,
    ambiguousPlaces: rules.ambiguousPlaces,
    flags: rules.flags,
    source: 'rules',
  };
  return { rules, base };
}

describe('merging the model with the rules', () => {
  it("keeps the model's confidence when the regexes found nothing", () => {
    // The old merge capped this at 0.5 — below the 0.55 handoff threshold — so
    // every sentence the regexes missed counted as unreadable, however clear.
    const text = 'anything landing before lunch?';
    const { rules, base } = baseFor(text);
    expect(rules.intent).toBe('UNKNOWN');
    const merged = mergeLlm(
      base,
      { intent: 'REFINE', confidence: 0.92, slots: { arriveWindow: { latest: '12:00' } }, tool: 'refine_search' },
      rules,
      text,
    );
    expect(merged.confidence).toBe(0.92);
    expect(merged.intent).toBe('REFINE');
    expect(merged.trip.arriveWindow).toEqual({ latest: '12:00' });
  });

  it('still lets the rules win where they are certain', () => {
    const text = 'let me talk to a human';
    const { rules, base } = baseFor(text);
    const merged = mergeLlm(base, { intent: 'FAQ', confidence: 0.4 }, rules, text);
    expect(merged.intent).toBe('REQUEST_HUMAN');
    expect(merged.confidence).toBe(base.confidence);
  });

  it('prefers the rules over the model for a time the regexes already read', () => {
    const out = mergeTrip({ arriveWindow: { latest: '12:00' } }, { arriveWindow: { latest: '11:00' } });
    expect(out.arriveWindow).toEqual({ latest: '12:00' });
  });

  it('drops a model time window that is not real HH:mm', () => {
    expect(timeWindow({ latest: '12 PM' })).toBeUndefined();
    expect(timeWindow({ earliest: '25:00' })).toBeUndefined();
    expect(timeWindow('before noon')).toBeUndefined();
    expect(timeWindow({ earliest: '06:00', latest: 'soon' })).toEqual({ earliest: '06:00' });
  });
});
