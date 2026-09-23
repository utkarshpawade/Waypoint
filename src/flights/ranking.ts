import { DateTime } from 'luxon';
import { qualityScore } from './airlines.js';
import type { FlightOffer, Itin, PickLabel, Preference, RankedPick } from './types.js';

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

/**
 * Wall-clock time at the airport itself. Without setZone, luxon converts to
 * the *server's* zone — on a UTC host a 07:15 IST departure reads as 01:45,
 * and "morning flights" quietly returns the afternoon ones.
 */
function atAirport(iso: string): DateTime {
  return DateTime.fromISO(iso, { setZone: true });
}

export function departHour(o: FlightOffer): number {
  return atAirport(o.outbound.segments[0].departISO).hour;
}

/** Minutes after local midnight that the itinerary departs. */
export function departMinutes(itin: Itin): number {
  const d = atAirport(itin.segments[0].departISO);
  return d.hour * 60 + d.minute;
}

/**
 * Minutes after midnight *of the departure day* that the itinerary lands, in
 * the destination's local time. A next-day 01:30 arrival is 1530, so it never
 * satisfies "reaching before noon".
 */
export function arrivalMinutes(itin: Itin): number {
  const dep = atAirport(itin.segments[0].departISO);
  const arr = atAirport(itin.segments.at(-1)!.arriveISO);
  const day = (d: DateTime) => DateTime.fromISO(d.toISODate()!, { zone: 'utc' });
  const days = Math.round(day(arr).diff(day(dep), 'days').days);
  return days * 1440 + arr.hour * 60 + arr.minute;
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

/** A flight is only "faster" if it saves at least this much — 5 minutes is noise. */
const MEANINGFULLY_FASTER_MIN = 15;

/**
 * Up to three labelled picks, never the same flight twice, and every label
 * literally true:
 *
 *  - 💰 is the cheapest offer in the set.
 *  - ⚡ appears only if something is meaningfully quicker than the cheapest.
 *    When the cheapest is also the quickest, it says so instead.
 *  - ⭐ goes to the best balance among the rest — unless an offer already
 *    shown beats it on both price and time, in which case calling it "best
 *    value" would be a lie and it is shown as an alternative.
 *
 * With one or two offers the user sees one or two cards, not a padded three.
 */
export function topThree(offers: FlightOffer[], pref: Preference = 'BEST_VALUE'): RankedPick[] {
  if (!offers.length) return [];
  const factors = factorsFor(offers);
  const score = (o: FlightOffer, p: Preference) => scoreOffer(factors.get(o.id)!, p);

  const orderBy = (cmp: (a: FlightOffer, b: FlightOffer) => number) => [...offers].sort(cmp);
  const byPrice = orderBy((a, b) => a.price.total - b.price.total || totalDuration(a) - totalDuration(b));
  const byDuration = orderBy((a, b) => totalDuration(a) - totalDuration(b) || a.price.total - b.price.total);
  const valuePref: Preference = pref === 'CHEAPEST' || pref === 'FASTEST' ? 'BEST_VALUE' : pref;
  const byValue = orderBy((a, b) => score(a, valuePref) - score(b, valuePref));

  const picks: RankedPick[] = [];
  const taken = new Set<string>();
  const add = (label: PickLabel, o: FlightOffer, p: Preference) => {
    taken.add(o.id);
    picks.push({ label, offer: o, score: score(o, p), whyThisOne: '' });
  };

  if (offers.length === 1) {
    add('ONLY', offers[0], pref);
  } else {
    const cheapest = byPrice[0];
    add('CHEAPEST', cheapest, 'CHEAPEST');

    const quickest = byDuration.find((o) => !taken.has(o.id))!;
    if (totalDuration(quickest) <= totalDuration(cheapest) - MEANINGFULLY_FASTER_MIN) {
      add('FASTEST', quickest, 'FASTEST');
    } else {
      picks[0].alsoFastest = true;
    }

    const dominated = (o: FlightOffer) =>
      picks.some(
        (p) => p.offer.price.total <= o.price.total && totalDuration(p.offer) <= totalDuration(o),
      );
    const value = byValue.find((o) => !taken.has(o.id) && !dominated(o));
    if (value) add('BEST_VALUE', value, valuePref);
    for (const o of byValue) {
      if (picks.length >= 3) break;
      if (!taken.has(o.id)) add('ALTERNATIVE', o, valuePref);
    }
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
  if (pick.label === 'CHEAPEST' || pick.label === 'ONLY') {
    const quickToo = pick.alsoFastest ? ' and no slower' : '';
    if (pick.label === 'ONLY') advantages.push('the only flight that matches');
    else if (priceDelta >= 50) advantages.push(`${formatINR(priceDelta)} less than the next option${quickToo}`);
    else if (pick.alsoFastest) advantages.push('the lowest fare, and as quick as any');
  } else if (pick.label === 'FASTEST' && timeDelta <= 0) {
    const beat = fastestOther - myDuration;
    advantages.push(beat >= 30 ? `quickest by ${formatDuration(beat)}` : 'the quickest here');
  } else if (pick.label === 'ALTERNATIVE') {
    // Not the cheapest or the quickest, so say what it *does* offer.
    const band = (h: number) => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');
    if (others.every((o) => band(departHour(o.offer)) !== band(hour))) {
      advantages.push(`a ${band(hour)} departure (${departTime(me)}) if that suits you better`);
    } else if (others.every((o) => o.offer.baggage.checkInKg < me.baggage.checkInKg)) {
      advantages.push(`more baggage (${me.baggage.checkInKg}kg)`);
    }
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
    advantages.push(`best baggage here (${me.baggage.checkInKg}kg)`);
  }

  // ── the catch, so the pick is honest rather than sold ─────────────────────
  if (hour >= 21 || hour < 5) catches.push({ priority: 9, text: `it's a ${departTime(me)} departure` });
  if (tight.length) catches.push({ priority: 8, text: `the ${tight[0]}m connection is tight` });
  if (timeDelta >= 60) catches.push({ priority: 7, text: `${formatDuration(timeDelta)} longer than the fastest` });
  if (me.outbound.stops >= 2 && !others.every((o) => o.offer.outbound.stops >= 2)) {
    catches.push({ priority: 6, text: `${me.outbound.stops} stops` });
  }
  if ((pick.label === 'FASTEST' || pick.label === 'ALTERNATIVE') && priceDelta <= -400) {
    catches.push({ priority: 5, text: `${formatINR(-priceDelta)} more than the cheapest` });
  }

  // ── compose ───────────────────────────────────────────────────────────────
  const nonStopNote =
    nonStop && others.length && !othersNonStop && advantages[0] !== 'the only non-stop here' ? ' and non-stop' : '';
  const catchText = catches.sort((a, b) => b.priority - a.priority)[0]?.text;

  if (advantages.length) {
    const head = advantages[0] + nonStopNote;
    const line = catchText ? `${head} — but ${catchText}` : head;
    return line.charAt(0).toUpperCase() + line.slice(1) + '.';
  }
  const base = {
    CHEAPEST: 'The lowest fare here',
    FASTEST: 'The quickest here',
    BEST_VALUE: 'The most balanced option on price, time and stops',
    ALTERNATIVE: 'Another solid option',
    ONLY: 'The only flight that matches',
    CLOSEST: 'The nearest to the time you asked for',
  }[pick.label];
  return catchText ? `${base} — but ${catchText}.` : `${base}.`;
}

export interface RefineFilters {
  nonStopOnly?: boolean;
  maxPrice?: number;
  departWindow?: { earliest?: string; latest?: string };
  arriveWindow?: { earliest?: string; latest?: string };
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
    if (f.departWindow && !inWindow(departMinutes(o.outbound), f.departWindow)) return false;
    if (f.arriveWindow && !inWindow(arrivalMinutes(o.outbound), f.arriveWindow)) return false;
    return true;
  });
}

/**
 * How far outside a window a time falls, in minutes — 0 when inside. Used to
 * show the *nearest* flights when nothing meets the constraint exactly.
 */
export function windowMiss(mins: number, w: { earliest?: string; latest?: string }): number {
  if (w.earliest && mins < toMinutes(w.earliest)) return toMinutes(w.earliest) - mins;
  if (w.latest && mins > toMinutes(w.latest)) return mins - toMinutes(w.latest);
  return 0;
}

function inWindow(mins: number, w: { earliest?: string; latest?: string }): boolean {
  return windowMiss(mins, w) === 0;
}

/** 1530 → "01:30 (next day)". */
export function clockTime(mins: number): string {
  const hh = String(Math.floor(mins / 60) % 24).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}${mins >= 1440 ? ' (next day)' : ''}`;
}

/**
 * When no flight meets a time the user asked for, the time is what matters to
 * them — so the cards are ordered by how close each gets to it, and each one
 * says its own time and how its fare compares with the nearest.
 */
export function nearestPicks(
  offers: FlightOffer[],
  which: 'depart' | 'arrive',
  w: { earliest?: string; latest?: string },
): RankedPick[] {
  const time = (o: FlightOffer) => (which === 'depart' ? departMinutes(o.outbound) : arrivalMinutes(o.outbound));
  const verb = which === 'depart' ? 'Leaves' : 'Lands';
  const ranked = [...offers]
    .sort((a, b) => windowMiss(time(a), w) - windowMiss(time(b), w) || a.price.total - b.price.total)
    .slice(0, 3);
  const nearest = ranked[0];
  return ranked.map((o, i) => {
    let why = `${verb} at ${clockTime(time(o))}`;
    if (i === 0) {
      why += ' — the nearest to the time you asked for.';
    } else {
      const delta = o.price.total - nearest.price.total;
      why +=
        delta <= -50
          ? `, ${formatINR(-delta)} cheaper than the closest.`
          : delta >= 50
            ? ` — but ${formatINR(delta)} more than the closest.`
            : ', at about the same fare.';
    }
    return { label: i === 0 ? 'CLOSEST' : 'ALTERNATIVE', offer: o, score: 0, whyThisOne: why };
  });
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
