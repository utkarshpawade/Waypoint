import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  departComfortScore,
  explainPick,
  factorsFor,
  layoverQualityScore,
  rankOffers,
  scoreOffer,
  topThree,
  totalDuration,
  WEIGHTS,
} from '../src/flights/ranking.js';
import { generateOffers } from '../src/flights/mock.js';
import type { FlightOffer, Itin, SearchQuery } from '../src/flights/types.js';

function itin(opts: {
  from?: string;
  to?: string;
  depart: string;
  durationMin: number;
  stops?: number;
  carrier?: string;
  layovers?: number[];
}): Itin {
  const stops = opts.stops ?? 0;
  const depart = opts.depart;
  const arrive = new Date(new Date(depart).getTime() + opts.durationMin * 60_000).toISOString();
  return {
    segments: Array.from({ length: stops + 1 }, (_, i) => ({
      carrierCode: opts.carrier ?? '6E',
      carrierName: 'Test Air',
      flightNumber: `${opts.carrier ?? '6E'}-${100 + i}`,
      from: i === 0 ? (opts.from ?? 'BLR') : 'DEL',
      to: i === stops ? (opts.to ?? 'DXB') : 'DEL',
      departISO: depart,
      arriveISO: arrive,
      durationMin: Math.round(opts.durationMin / (stops + 1)),
    })),
    totalDurationMin: opts.durationMin,
    stops,
    layoverMin: opts.layovers ?? Array.from({ length: stops }, () => 120),
  };
}

function offer(id: string, price: number, out: Itin, extra: Partial<FlightOffer> = {}): FlightOffer {
  return {
    id,
    outbound: out,
    price: { total: price, perAdult: price, currency: 'INR' },
    cabin: 'ECONOMY',
    refundable: false,
    baggage: { cabinKg: 7, checkInKg: 15 },
    provider: 'mock',
    ...extra,
  };
}

// A small, fully controlled candidate set.
const CHEAP_SLOW = offer('cheap', 10_000, itin({ depart: '2026-01-10T03:30:00+05:30', durationMin: 600, stops: 1 }));
const FAST_PRICEY = offer('fast', 20_000, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 240 }));
const BALANCED = offer('balanced', 13_000, itin({ depart: '2026-01-10T10:20:00+05:30', durationMin: 265 }));
const SET = [CHEAP_SLOW, FAST_PRICEY, BALANCED];

describe('normalisation', () => {
  it('maps the best and worst of a set-relative factor to 0 and 1', () => {
    const f = factorsFor(SET);
    expect(f.get('cheap')!.price).toBe(0);
    expect(f.get('fast')!.price).toBe(1);
    expect(f.get('fast')!.duration).toBe(0);
    expect(f.get('cheap')!.duration).toBe(1);
  });

  it('collapses a factor to 0 when every candidate is identical', () => {
    const same = [offer('a', 5000, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 120 }))];
    expect(factorsFor(same).get('a')!.price).toBe(0);
  });

  it('scores departure comfort absolutely, so a 3am flight is punished even in an all-red-eye set', () => {
    expect(departComfortScore(9)).toBe(0);
    expect(departComfortScore(6)).toBe(0.15);
    expect(departComfortScore(13)).toBe(0.1);
    expect(departComfortScore(19)).toBe(0.2);
    expect(departComfortScore(23)).toBe(0.6);
    expect(departComfortScore(3)).toBe(0.6);
  });

  it('treats a tight connection as worse than a long one, and a non-stop as perfect', () => {
    const nonStop = offer('n', 1, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 120 }));
    const tight = offer('t', 1, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 400, stops: 1, layovers: [50] }));
    const dead = offer('d', 1, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 400, stops: 1, layovers: [300] }));
    const ok = offer('o', 1, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 400, stops: 1, layovers: [120] }));
    expect(layoverQualityScore(nonStop)).toBe(0);
    expect(layoverQualityScore(ok)).toBe(0.1);
    expect(layoverQualityScore(dead)).toBe(0.35);
    expect(layoverQualityScore(tight)).toBe(0.5);
  });
});

describe('weights', () => {
  it('every preference profile sums to 1', () => {
    for (const [pref, w] of Object.entries(WEIGHTS)) {
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum, pref).toBeCloseTo(1, 6);
    }
  });

  it('CHEAPEST puts the lowest fare first', () => {
    expect(rankOffers(SET, 'CHEAPEST')[0].offer.id).toBe('cheap');
  });

  it('FASTEST scores on speed but is still a weighted score, not a sort by duration', () => {
    // 'balanced' is 25m slower than 'fast' and ₹7,000 cheaper, so it can win
    // the FASTEST *score*. The literal ⚡ label never moves — topThree picks
    // that one by minimum duration, which the label test below pins down.
    const ranked = rankOffers(SET, 'FASTEST');
    expect(ranked[0].offer.id).not.toBe('cheap');
    expect(ranked.at(-1)!.offer.id).toBe('cheap');
    expect(topThree(SET).find((p) => p.label === 'FASTEST')!.offer.id).toBe('fast');
  });

  it('BEST_VALUE prefers the balanced option over both extremes', () => {
    expect(rankOffers(SET, 'BEST_VALUE')[0].offer.id).toBe('balanced');
  });

  it('the same factors score differently under different preferences', () => {
    const f = factorsFor(SET).get('cheap')!;
    expect(scoreOffer(f, 'CHEAPEST')).toBeLessThan(scoreOffer(f, 'FASTEST'));
  });
});

describe('topThree', () => {
  it('returns exactly three distinct offers with the three labels', () => {
    const picks = topThree(SET);
    expect(picks).toHaveLength(3);
    expect(picks.map((p) => p.label)).toEqual(['CHEAPEST', 'FASTEST', 'BEST_VALUE']);
    expect(new Set(picks.map((p) => p.offer.id)).size).toBe(3);
  });

  it('labels stay truthful: the cheapest label is the cheapest offer', () => {
    const picks = topThree(SET);
    const cheapest = picks.find((p) => p.label === 'CHEAPEST')!;
    expect(cheapest.offer.price.total).toBe(Math.min(...SET.map((o) => o.price.total)));
  });

  it('falls back to the runner-up when one offer would win two labels', () => {
    // One offer is both cheapest and fastest; the third label must still get
    // a different flight, and all three picks must remain distinct.
    const dominant = offer('dom', 5000, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 120 }));
    const mid = offer('mid', 8000, itin({ depart: '2026-01-10T11:00:00+05:30', durationMin: 200 }));
    const worst = offer('worst', 9000, itin({ depart: '2026-01-10T02:00:00+05:30', durationMin: 500, stops: 2 }));
    const picks = topThree([dominant, mid, worst]);
    expect(new Set(picks.map((p) => p.offer.id)).size).toBe(3);
    expect(picks.find((p) => p.label === 'CHEAPEST')!.offer.id).toBe('dom');
  });

  it('survives a single-offer set without crashing', () => {
    const picks = topThree([CHEAP_SLOW]);
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.offer.id === 'cheap')).toBe(true);
  });

  it('returns nothing for an empty set', () => {
    expect(topThree([])).toEqual([]);
  });
});

describe('whyThisOne', () => {
  it('quantifies the saving on the cheapest pick and names the catch', () => {
    const picks = topThree(SET);
    const why = picks.find((p) => p.label === 'CHEAPEST')!.whyThisOne;
    expect(why).toMatch(/₹3,000 less/);
    expect(why).toMatch(/but/);
  });

  it('explains the value pick as a trade against the fastest', () => {
    const why = topThree(SET).find((p) => p.label === 'BEST_VALUE')!.whyThisOne;
    expect(why).toMatch(/fastest/);
    expect(why).toMatch(/₹7,000 cheaper/);
  });

  it('never invents a number that is not a real delta', () => {
    for (const p of topThree(SET)) {
      for (const amount of p.whyThisOne.match(/₹[\d,]+/g) ?? []) {
        const n = Number(amount.replace(/[₹,]/g, ''));
        const realDeltas = SET.flatMap((a) => SET.map((b) => Math.abs(a.price.total - b.price.total)));
        expect(realDeltas).toContain(n);
      }
    }
  });

  it('flags a tight connection', () => {
    const tight = offer('t', 9000, itin({ depart: '2026-01-10T09:00:00+05:30', durationMin: 400, stops: 1, layovers: [55] }));
    const why = explainPick(
      { label: 'CHEAPEST', offer: tight, score: 0, whyThisOne: '' },
      [{ label: 'FASTEST', offer: FAST_PRICEY, score: 0, whyThisOne: '' }],
    );
    expect(why).toMatch(/55m connection is tight/);
  });

  it('always produces a non-empty sentence', () => {
    for (const p of topThree(SET)) {
      expect(p.whyThisOne.length).toBeGreaterThan(10);
      expect(p.whyThisOne.endsWith('.')).toBe(true);
    }
  });
});

describe('refinement filters', () => {
  it('filters by non-stop, price ceiling and departure window', () => {
    expect(applyFilters(SET, { nonStopOnly: true }).map((o) => o.id)).toEqual(['fast', 'balanced']);
    expect(applyFilters(SET, { maxPrice: 12_000 }).map((o) => o.id)).toEqual(['cheap']);
    expect(applyFilters(SET, { departWindow: { earliest: '06:00', latest: '12:00' } }).map((o) => o.id)).toEqual([
      'fast',
      'balanced',
    ]);
  });

  it('returns an empty set rather than throwing when nothing matches', () => {
    expect(applyFilters(SET, { maxPrice: 1 })).toEqual([]);
  });
});

describe('mock provider', () => {
  const q: SearchQuery = {
    origin: 'BLR',
    destination: 'DXB',
    departDate: '2026-03-15',
    adults: 2,
    cabin: 'ECONOMY',
    currency: 'INR',
  };

  it('is deterministic — the same query returns identical offers', () => {
    const a = generateOffers(q);
    const b = generateOffers(q);
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
    expect(a.map((o) => o.price.total)).toEqual(b.map((o) => o.price.total));
  });

  it('returns 12-18 offers with sane prices, durations and arrival ordering', () => {
    const offers = generateOffers(q);
    expect(offers.length).toBeGreaterThanOrEqual(12);
    expect(offers.length).toBeLessThanOrEqual(18);
    for (const o of offers) {
      expect(o.price.total).toBeGreaterThan(0);
      expect(totalDuration(o)).toBeGreaterThan(0);
      const first = new Date(o.outbound.segments[0].departISO).getTime();
      const last = new Date(o.outbound.segments.at(-1)!.arriveISO).getTime();
      expect(last).toBeGreaterThan(first);
      expect(o.outbound.layoverMin).toHaveLength(o.outbound.stops);
    }
  });

  it('scales the fare with distance', () => {
    const short = generateOffers({ ...q, origin: 'DEL', destination: 'JAI' });
    const long = generateOffers({ ...q, origin: 'DEL', destination: 'JFK' });
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(median(long.map((o) => o.price.total))).toBeGreaterThan(median(short.map((o) => o.price.total)));
  });

  it('charges more for business than economy on the same route', () => {
    const eco = generateOffers(q);
    const biz = generateOffers({ ...q, cabin: 'BUSINESS' });
    const min = (xs: number[]) => Math.min(...xs);
    expect(min(biz.map((o) => o.price.total))).toBeGreaterThan(min(eco.map((o) => o.price.total)));
  });

  it('ranks a real generated set without throwing', () => {
    const picks = topThree(generateOffers(q));
    expect(picks).toHaveLength(3);
    expect(new Set(picks.map((p) => p.offer.id)).size).toBe(3);
  });
});
