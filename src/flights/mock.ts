import { DateTime } from 'luxon';
import { airlinesFor, getAirline } from './airlines.js';
import { distanceBetween, getAirport, haversineKm, isInternational } from './airports.js';
import type { CabinClass, FlightOffer, FlightProvider, Itin, SearchQuery, Segment } from './types.js';

/**
 * Deterministic mock inventory.
 *
 * Seeded by hash(origin + destination + date + cabin), so the same query always
 * returns the same flights: reproducible demos, deterministic tests, and an
 * interviewer who searches twice sees the same fares.
 */

const CABIN_MULTIPLIER: Record<CabinClass, number> = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 1.6,
  BUSINESS: 3.2,
  FIRST: 5,
};

const HUBS_DOMESTIC = ['DEL', 'BOM', 'BLR', 'HYD', 'MAA', 'CCU'];
const HUBS_INTL = ['DXB', 'DOH', 'AUH', 'SIN', 'IST', 'BOM', 'DEL', 'BKK'];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough, and identical across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}

function flightMinutes(km: number): number {
  // ~800 km/h cruise + taxi, climb and descent overhead.
  return Math.round(35 + (km / 800) * 60);
}

/**
 * Departure bands, weighted the way a real schedule is: mostly daytime, with
 * roughly one red-eye in eight. Cycled by index so every option set is spread
 * rather than clustered.
 */
const BANDS: [number, number][] = [
  [6, 9], // early morning
  [9, 12], // morning
  [12, 15], // midday
  [7, 10], // morning again — the busiest bank
  [15, 18], // afternoon
  [18, 21], // evening
  [21, 24], // red-eye
  [5, 8], // dawn
];

function makeSegment(
  from: string,
  to: string,
  departLocal: DateTime,
  carrierCode: string,
  flightNo: number,
  r: () => number,
): Segment {
  const a = getAirport(from)!;
  const b = getAirport(to)!;
  const km = haversineKm(a, b);
  const durationMin = flightMinutes(km);
  const arrive = departLocal.toUTC().plus({ minutes: durationMin }).setZone(b.tz);
  const airline = getAirline(carrierCode);
  return {
    carrierCode,
    carrierName: airline?.name ?? carrierCode,
    flightNumber: `${carrierCode}-${flightNo}`,
    from,
    to,
    departISO: departLocal.toISO({ suppressMilliseconds: true })!,
    arriveISO: arrive.toISO({ suppressMilliseconds: true })!,
    durationMin,
    aircraft: pick(r, ['A320neo', 'A321neo', 'B737-800', 'B787-9', 'A350-900', 'B777-300ER']),
  };
}

function buildItinerary(
  origin: string,
  destination: string,
  date: string,
  hour: number,
  minute: number,
  stops: number,
  carrierCode: string,
  r: () => number,
): Itin | null {
  const originAp = getAirport(origin);
  const destAp = getAirport(destination);
  if (!originAp || !destAp) return null;

  const intl = isInternational(origin, destination);
  const viaPool = (intl ? HUBS_INTL : HUBS_DOMESTIC).filter(
    (h) => h !== origin && h !== destination && getAirport(h),
  );

  // Airlines connect through their own hub. Routing Scoot via Istanbul is the
  // kind of detail that makes mock data look like mock data.
  const home = getAirline(carrierCode)?.country;
  const homeHubs = home ? viaPool.filter((h) => getAirport(h)?.country === home) : [];

  const waypoints: string[] = [origin];
  for (let i = 0; i < stops; i++) {
    const candidates = (i === 0 && homeHubs.length ? homeHubs : viaPool).filter((h) => !waypoints.includes(h));
    const via = pick(r, candidates.length ? candidates : viaPool.filter((h) => !waypoints.includes(h)));
    if (!via) break;
    waypoints.push(via);
  }
  waypoints.push(destination);

  const segments: Segment[] = [];
  const layoverMin: number[] = [];
  let cursor = DateTime.fromISO(`${date}T00:00`, { zone: originAp.tz }).set({ hour, minute });

  for (let i = 0; i < waypoints.length - 1; i++) {
    const seg = makeSegment(
      waypoints[i],
      waypoints[i + 1],
      cursor,
      carrierCode,
      100 + Math.floor(r() * 899),
      r,
    );
    segments.push(seg);
    if (i < waypoints.length - 2) {
      // Layovers 55m–6h international, 55m–3h domestic; under 75m is flagged
      // as a tight connection downstream.
      const lay = 55 + Math.floor(r() * (intl ? 305 : 125));
      layoverMin.push(lay);
      // setZone:true keeps the connecting airport's own offset — without it the
      // next segment is stamped in the server's timezone and the itinerary
      // reads as arriving before it departs.
      cursor = DateTime.fromISO(seg.arriveISO, { setZone: true }).plus({ minutes: lay });
    }
  }

  const first = DateTime.fromISO(segments[0].departISO, { setZone: true });
  const last = DateTime.fromISO(segments[segments.length - 1].arriveISO, { setZone: true });
  return {
    segments,
    totalDurationMin: Math.round(last.diff(first, 'minutes').minutes),
    stops: segments.length - 1,
    layoverMin,
  };
}

function priceFor(
  q: SearchQuery,
  itin: Itin,
  r: () => number,
  distanceKm: number,
): number {
  const base = 1800 + distanceKm * 3.2;

  const depart = DateTime.fromISO(itin.segments[0].departISO);
  const daysOut = Math.max(0, Math.ceil(depart.diffNow('days').days));
  const leadMultiplier = daysOut < 3 ? 1.55 : daysOut < 7 ? 1.3 : daysOut < 21 ? 1.1 : 1.0;

  const weekend = [5, 6, 7].includes(depart.weekday) ? 1.12 : 1.0;
  const nonStop = itin.stops === 0 ? 1.18 : itin.stops === 1 ? 1.0 : 0.92;
  const hour = depart.hour;
  const redEye = hour >= 21 || hour < 5 ? 0.85 : 1.0;
  const jitter = 0.92 + r() * 0.16; // ±8%

  const perAdult =
    base * CABIN_MULTIPLIER[q.cabin] * leadMultiplier * weekend * nonStop * redEye * jitter;
  return Math.round(perAdult / 10) * 10;
}

export function generateOffers(q: SearchQuery): FlightOffer[] {
  const originAp = getAirport(q.origin);
  const destAp = getAirport(q.destination);
  if (!originAp || !destAp) return [];

  const seed = hashString(`${q.origin}|${q.destination}|${q.departDate}|${q.cabin}`);
  const r = rng(seed);

  const distanceKm = distanceBetween(q.origin, q.destination);
  const domestic = !isInternational(q.origin, q.destination);
  const pool = airlinesFor({
    domestic,
    distanceKm,
    originCountry: originAp.country,
    destCountry: destAp.country,
  });
  if (!pool.length) return [];

  // Non-stops are plausible up to ~7000km; beyond that most itineraries connect.
  const nonStopPlausible = distanceKm < 7000;
  const count = 12 + Math.floor(r() * 7); // 12–18

  const offers: FlightOffer[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < count; i++) {
    const airline = pool[i % pool.length];
    const band = BANDS[i % BANDS.length];
    const hour = band[0] + Math.floor(r() * Math.max(1, band[1] - band[0]));
    const minute = [0, 10, 15, 25, 35, 40, 50, 55][Math.floor(r() * 8)];

    // Routing realism: a short domestic hop is overwhelmingly non-stop and
    // never triple-connects; an ultra-long-haul almost always connects.
    let stops: number;
    if (!nonStopPlausible) stops = r() < 0.75 ? 1 : 2;
    else if (i < Math.ceil(count * (distanceKm < 1500 ? 0.62 : 0.45))) stops = 0;
    else if (distanceKm < 1500) stops = 1;
    else stops = r() < 0.82 ? 1 : 2;

    const itin = buildItinerary(q.origin, q.destination, q.departDate, hour % 24, minute, stops, airline.code, r);
    if (!itin) continue;

    const key = `${itin.segments[0].flightNumber}-${itin.segments[0].departISO}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    let inbound: Itin | undefined;
    if (q.returnDate) {
      const rHour = BANDS[(i + 2) % BANDS.length][0] + Math.floor(r() * 3);
      const built = buildItinerary(
        q.destination,
        q.origin,
        q.returnDate,
        rHour % 24,
        minute,
        stops,
        airline.code,
        r,
      );
      if (built) inbound = built;
    }

    const outPrice = priceFor(q, itin, r, distanceKm);
    const perAdult = inbound ? Math.round((outPrice * 1.88) / 10) * 10 : outPrice;
    const adults = Math.max(1, q.adults);
    const total =
      perAdult * adults +
      Math.round(perAdult * 0.75) * (q.children ?? 0) +
      Math.round(perAdult * 0.1) * (q.infants ?? 0);

    offers.push({
      id: `${airline.code}${itin.segments[0].flightNumber.split('-')[1]}-${i}`,
      outbound: itin,
      inbound,
      price: { total, perAdult, currency: 'INR' },
      cabin: q.cabin,
      seatsRemaining: r() < 0.3 ? 1 + Math.floor(r() * 6) : undefined,
      refundable: r() < 0.25,
      baggage: {
        cabinKg: airline.cabinKg,
        checkInKg: q.cabin === 'ECONOMY' ? airline.checkInKg : airline.checkInKg + 10,
      },
      provider: 'mock',
    });
  }

  return offers;
}

export class MockProvider implements FlightProvider {
  readonly name = 'mock';
  async search(q: SearchQuery): Promise<FlightOffer[]> {
    return generateOffers(q);
  }
}
