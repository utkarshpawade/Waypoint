import { DateTime } from 'luxon';
import { qualityScore } from './airlines.js';
import type { FlightOffer, PickLabel, Preference, RankedPick } from './types.js';

/**
 * "Best flight" is not a sort — it is a weighted score across six normalised
 * factors, and the user is told in one line why this one won. Pure functions
 * only: no I/O, no LLM, fully unit-tested (tests/ranking.test.ts).
 */

export interface Factors {
  price: number;
  duration: number;
  stops: number;
  departComfort: number;
  layoverQuality: number;
  carrier: number;
}

export const WEIGHTS: Record<Preference, Factors> = {
  CHEAPEST: { price: 0.75, duration: 0.1, stops: 0.05, departComfort: 0.02, layoverQuality: 0.03, carrier: 0.05 },
  FASTEST: { price: 0.1, duration: 0.55, stops: 0.2, departComfort: 0.03, layoverQuality: 0.07, carrier: 0.05 },
  BEST_VALUE: { price: 0.4, duration: 0.25, stops: 0.12, departComfort: 0.08, layoverQuality: 0.08, carrier: 0.07 },
  COMFORT: { price: 0.15, duration: 0.2, stops: 0.2, departComfort: 0.15, layoverQuality: 0.15, carrier: 0.15 },
};

export function totalDuration(o: FlightOffer): number {
  return o.outbound.totalDurationMin + (o.inbound?.totalDurationMin ?? 0);
}

export function departHour(o: FlightOffer): number {
  return DateTime.fromISO(o.outbound.segments[0].departISO).hour;
}

/** 0 = best. An 09:00 departure is ideal; a 2am one is punishing. */
export function departComfortScore(hour: number): number {
  if (hour >= 5 && hour < 8) return 0.15;
  if (hour >= 8 && hour < 12) return 0;
  if (hour >= 12 && hour < 17) return 0.1;
  if (hour >= 17 && hour < 21) return 0.2;
  return 0.6; // 21:00–05:00
}

/** 0 = best. Tight connections are risky; very long ones are dead time. */
export function layoverQualityScore(o: FlightOffer): number {
  const lays = [...o.outbound.layoverMin, ...(o.inbound?.layoverMin ?? [])];
  if (!lays.length) return 0;
  const worst = lays.map((m) => (m < 75 ? 0.5 : m > 240 ? 0.35 : 0.1));
  return Math.max(...worst);
}

function minMax(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 0;
  return (v) => (v - min) / (max - min);
}

export function factorsFor(offers: FlightOffer[]): Map<string, Factors> {
  const priceN = minMax(offers.map((o) => o.price.total));
  const durationN = minMax(offers.map(totalDuration));
  const out = new Map<string, Factors>();
  for (const o of offers) {
    out.set(o.id, {
      // Price and duration are normalised across the candidate set — their
      // absolute scale is route-dependent and meaningless on its own.
      price: priceN(o.price.total),
      duration: durationN(totalDuration(o)),
      // The rest are already absolute 0–1 quality scores, so they stay
      // comparable even when every candidate is equally bad.
      stops: Math.min(1, (o.outbound.stops + (o.inbound?.stops ?? 0)) / 2),
      departComfort: departComfortScore(departHour(o)),
      layoverQuality: layoverQualityScore(o),
      carrier: 1 - qualityScore(o.outbound.segments[0].carrierCode),
    });
  }
  return out;
}

export function scoreOffer(f: Factors, pref: Preference): number {
  const w = WEIGHTS[pref];
  return (
    w.price * f.price +
    w.duration * f.duration +
    w.stops * f.stops +
    w.departComfort * f.departComfort +
    w.layoverQuality * f.layoverQuality +
    w.carrier * f.carrier
  );
}

export interface ScoredOffer {
  offer: FlightOffer;
  factors: Factors;
  score: number;
}

/** Lowest score wins. */
export function rankOffers(offers: FlightOffer[], pref: Preference = 'BEST_VALUE'): ScoredOffer[] {
  const factors = factorsFor(offers);
  return offers
    .map((offer) => {
      const f = factors.get(offer.id)!;
      return { offer, factors: f, score: scoreOffer(f, pref) };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * Exactly three labelled picks, deduped: if one offer wins two labels the
 * second label takes the runner-up, so the user always sees three real choices.
 */
export function topThree(offers: FlightOffer[], pref: Preference = 'BEST_VALUE'): RankedPick[] {
  if (!offers.length) return [];
  const factors = factorsFor(offers);
  const score = (o: FlightOffer, p: Preference) => scoreOffer(factors.get(o.id)!, p);

  const orderBy = (cmp: (a: FlightOffer, b: FlightOffer) => number) => [...offers].sort(cmp);
  const byPrice = orderBy((a, b) => a.price.total - b.price.total || totalDuration(a) - totalDuration(b));
  const byDuration = orderBy((a, b) => totalDuration(a) - totalDuration(b) || a.price.total - b.price.total);
  const byValue = orderBy((a, b) => score(a, 'BEST_VALUE') - score(b, 'BEST_VALUE'));

  const candidates: { label: PickLabel; ordered: FlightOffer[] }[] = [
    { label: 'CHEAPEST', ordered: byPrice },
    { label: 'FASTEST', ordered: byDuration },
    { label: 'BEST_VALUE', ordered: byValue },
  ];

  const taken = new Set<string>();
  const picks: RankedPick[] = [];
  for (const c of candidates) {
    const chosen = c.ordered.find((o) => !taken.has(o.id)) ?? c.ordered[0];
    taken.add(chosen.id);
    picks.push({
      label: c.label,
      offer: chosen,
      score: score(chosen, c.label === 'BEST_VALUE' ? pref : c.label),
      whyThisOne: '',
    });
  }

  for (const p of picks) {
    p.whyThisOne = explainPick(
      p,
      picks.filter((x) => x !== p),
    );
  }
  return picks;
}

export function formatINR(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function departTime(o: FlightOffer): string {
  return o.outbound.segments[0].departISO.slice(11, 16);
}

/**
 * The line an interviewer remembers. Computed from the numbers — never from the
 * LLM — by diffing this pick against the other two and surfacing the largest
 * meaningful deltas. Two clauses maximum, so it stays one readable line: the
 * advantage this pick actually has, and the catch that comes with it.
 */
export function explainPick(pick: RankedPick, others: RankedPick[]): string {
  const me = pick.offer;
  const myDuration = totalDuration(me);
  const advantages: string[] = [];
  const catches: { priority: number; text: string }[] = [];

  const cheapestOther = others.length ? Math.min(...others.map((o) => o.offer.price.total)) : me.price.total;
  const fastestOther = others.length ? Math.min(...others.map((o) => totalDuration(o.offer))) : myDuration;
  const priceDelta = cheapestOther - me.price.total; // positive → this one is cheaper
  const timeDelta = myDuration - fastestOther; // positive → this one is slower

  const byLabel = (l: PickLabel) => others.find((o) => o.label === l);
  const cheapPick = byLabel('CHEAPEST');
  const fastPick = byLabel('FASTEST');

  const hour = departHour(me);
  const nonStop = me.outbound.stops === 0;
  const othersNonStop = others.some((o) => o.offer.outbound.stops === 0);
  const tight = [...me.outbound.layoverMin, ...(me.inbound?.layoverMin ?? [])].filter((m) => m < 75);

  // ── the advantage ─────────────────────────────────────────────────────────
  if (pick.label === 'CHEAPEST' && priceDelta >= 400) {
    advantages.push(`${formatINR(priceDelta)} less than the next option`);
  } else if (pick.label === 'FASTEST' && timeDelta <= 0) {
    const beat = fastestOther - myDuration;
    advantages.push(beat >= 30 ? `quickest by ${formatDuration(beat)}` : 'the quickest of the three');
  } else if (pick.label === 'BEST_VALUE') {
    // A value pick only means something as a trade against both neighbours.
    const vsCheap = cheapPick
      ? { time: totalDuration(cheapPick.offer) - myDuration, price: me.price.total - cheapPick.offer.price.total }
      : null;
    const vsFast = fastPick
      ? { time: myDuration - totalDuration(fastPick.offer), price: fastPick.offer.price.total - me.price.total }
      : null;
    if (vsFast && vsFast.price >= 400 && vsFast.time < 60) {
      advantages.push(
        vsFast.time <= 5
          ? `same flight time as the fastest, ${formatINR(vsFast.price)} cheaper`
          : `only ${formatDuration(vsFast.time)} slower than the fastest, ${formatINR(vsFast.price)} cheaper`,
      );
    } else if (vsCheap && vsCheap.time >= 45) {
      advantages.push(
        vsCheap.price > 400
          ? `${formatDuration(vsCheap.time)} shorter than the cheapest for ${formatINR(vsCheap.price)} more`
          : `${formatDuration(vsCheap.time)} shorter than the cheapest at almost the same fare`,
      );
    }
  }

  if (!advantages.length && nonStop && !othersNonStop) advantages.push('the only non-stop here');
  if (!advantages.length && priceDelta >= 400) advantages.push(`${formatINR(priceDelta)} cheaper than the alternatives`);
  if (!advantages.length && me.baggage.checkInKg >= 30 && !others.some((o) => o.offer.baggage.checkInKg >= 30)) {
    advantages.push(`best baggage of the three (${me.baggage.checkInKg}kg)`);
  }

  // ── the catch, so the pick is honest rather than sold ─────────────────────
  if (hour >= 21 || hour < 5) catches.push({ priority: 9, text: `it's a ${departTime(me)} departure` });
  if (tight.length) catches.push({ priority: 8, text: `the ${tight[0]}m connection is tight` });
  if (timeDelta >= 60) catches.push({ priority: 7, text: `${formatDuration(timeDelta)} longer than the fastest` });
  if (me.outbound.stops >= 2 && !others.every((o) => o.offer.outbound.stops >= 2)) {
    catches.push({ priority: 6, text: `${me.outbound.stops} stops` });
  }
  if (pick.label === 'FASTEST' && priceDelta <= -400) {
    catches.push({ priority: 5, text: `${formatINR(-priceDelta)} more than the cheapest` });
  }

  // ── compose ───────────────────────────────────────────────────────────────
  const nonStopNote = nonStop && !othersNonStop && advantages[0] !== 'the only non-stop here' ? ' and non-stop' : '';
  const catchText = catches.sort((a, b) => b.priority - a.priority)[0]?.text;

  if (advantages.length) {
    const head = advantages[0] + nonStopNote;
    const line = catchText ? `${head} — but ${catchText}` : head;
    return line.charAt(0).toUpperCase() + line.slice(1) + '.';
  }
  if (catchText) {
    const base =
      pick.label === 'BEST_VALUE' ? 'The most balanced of the three' : 'Closest match for what you asked for';
    return `${base} — but ${catchText}.`;
  }
  return pick.label === 'BEST_VALUE'
    ? 'The most balanced of the three on price, time and stops.'
    : 'Closest match for what you asked for.';
}

export interface RefineFilters {
  nonStopOnly?: boolean;
  maxPrice?: number;
  departWindow?: { earliest?: string; latest?: string };
  preference?: Preference;
  carrier?: string;
}

/**
 * Re-rank the CACHED offer set against new filters. "Anything cheaper?" and
 * "morning only" are then instant, and cost zero provider/LLM quota.
 */
export function applyFilters(offers: FlightOffer[], f: RefineFilters): FlightOffer[] {
  return offers.filter((o) => {
    if (f.nonStopOnly && o.outbound.stops !== 0) return false;
    if (f.maxPrice && o.price.total > f.maxPrice) return false;
    if (f.carrier && o.outbound.segments[0].carrierCode !== f.carrier.toUpperCase()) return false;
    if (f.departWindow) {
      const dt = DateTime.fromISO(o.outbound.segments[0].departISO);
      const mins = dt.hour * 60 + dt.minute;
      if (f.departWindow.earliest && mins < toMinutes(f.departWindow.earliest)) return false;
      if (f.departWindow.latest && mins > toMinutes(f.departWindow.latest)) return false;
    }
    return true;
  });
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
