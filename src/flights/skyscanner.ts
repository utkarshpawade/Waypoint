import { DateTime } from 'luxon';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAirline } from './airlines.js';
import { getAirport } from './airports.js';
import type { CabinClass, FlightOffer, FlightProvider, Itin, SearchQuery, Segment } from './types.js';

const log = logger.child({ mod: 'skyscanner' });

/**
 * Live fares from Skyscanner, through the "Sky Scrapper" API on RapidAPI
 * (sky-scrapper.p.rapidapi.com).
 *
 * A search needs each airport's Skyscanner entity id. Known ones are listed
 * below, and every id seen in a result is remembered, so after the first few
 * searches a new search is usually a single request.
 *
 * Only the price and schedule are live. Skyscanner does not report baggage,
 * so the allowance shown is the carrier's usual one from airlines.json.
 *
 * Every Skyscanner shape is flattened in mapItinerary() so it never leaks past
 * this file — the same contract as amadeus.ts.
 */

const CABIN: Record<CabinClass, string> = {
  ECONOMY: 'economy',
  PREMIUM_ECONOMY: 'premium_economy',
  BUSINESS: 'business',
  FIRST: 'first',
};

/**
 * The free Basic plan is 20 requests a month. A search costs 1–3 of them, so
 * results are cached for an hour and nothing is called once the quota is gone.
 */
const CACHE_MS = 60 * 60_000;
const MARKET = { currency: 'INR', market: 'en-US', countryCode: 'IN' };

/**
 * Skyscanner entity ids already looked up — each one saves a request on every
 * search that touches that airport. Add to it from the `skyscanner entity`
 * log line.
 */
const KNOWN_ENTITIES: Record<string, string> = {
  DEL: '95673498',
  GOI: '95790306',
};

export class SkyscannerProvider implements FlightProvider {
  readonly name = 'skyscanner';
  private readonly entities = new Map<string, { skyId: string; entityId: string }>(
    Object.entries(KNOWN_ENTITIES).map(([iata, entityId]) => [iata, { skyId: iata, entityId }]),
  );
  private readonly cache = new Map<string, { at: number; offers: FlightOffer[] }>();
  /** Set when the plan's quota is used up: no more calls until it resets. */
  private blockedUntil = 0;

  constructor(private readonly budgetMs = 15_000) {}

  async search(q: SearchQuery): Promise<FlightOffer[]> {
    const key = [q.origin, q.destination, q.departDate, q.returnDate ?? '', q.adults, q.children ?? 0, q.infants ?? 0, q.cabin].join('|');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.offers;
    if (Date.now() < this.blockedUntil) {
      throw new Error(`skyscanner quota used up until ${new Date(this.blockedUntil).toISOString()}`);
    }

    const deadline = Date.now() + this.budgetMs;
    // One at a time: free RapidAPI plans cap requests per second, and two
    // parallel lookups are enough to trip it.
    const from = await this.entity(q.origin, deadline);
    const to = await this.entity(q.destination, deadline);

    const params = new URLSearchParams({
      originSkyId: from.skyId,
      destinationSkyId: to.skyId,
      originEntityId: from.entityId,
      destinationEntityId: to.entityId,
      date: q.departDate,
      cabinClass: CABIN[q.cabin],
      adults: String(q.adults),
      sortBy: 'best',
      ...MARKET,
    });
    if (q.returnDate) params.set('returnDate', q.returnDate);
    if (q.children) params.set('childrens', String(q.children));
    if (q.infants) params.set('infants', String(q.infants));

    // The first page is used as it comes. Skyscanner marks it "incomplete"
    // while more agents report in, but on a 20-request plan a second call per
    // search costs more than the extra fares are worth.
    const body = await this.get('/api/v1/flights/searchFlights', params, deadline);
    const data = body?.data;

    const raw: any[] = Array.isArray(data?.itineraries) ? data.itineraries : [];
    this.learnEntities(raw);
    // Self-transfer itineraries mean re-checking bags and no protection if the
    // first leg is late. Only offer them when there is nothing else.
    const protectedOnes = raw.filter((it) => !it?.isSelfTransfer);
    const mapped = (protectedOnes.length ? protectedOnes : raw)
      .map((it) => mapItinerary(it, q))
      .filter((o): o is FlightOffer => o !== null);
    const offers = keepUseful(mapped);

    log.info(
      { route: `${q.origin}-${q.destination}`, raw: raw.length, kept: offers.length, status: data?.context?.status },
      'skyscanner offers',
    );
    if (offers.length) this.cache.set(key, { at: Date.now(), offers });
    return offers;
  }

  /** Every segment names its airports' entity ids — keep them, each one is a lookup saved. */
  private learnEntities(itineraries: any[]): void {
    for (const it of itineraries) {
      for (const leg of it?.legs ?? []) {
        for (const seg of leg?.segments ?? []) {
          for (const place of [seg?.origin, seg?.destination]) {
            const iata = String(place?.displayCode ?? place?.flightPlaceId ?? '').toUpperCase();
            if (/^[A-Z]{3}$/.test(iata) && place?.entityId && !this.entities.has(iata)) {
              this.entities.set(iata, { skyId: iata, entityId: String(place.entityId) });
            }
          }
        }
      }
    }
  }

  private async entity(iata: string, deadline: number): Promise<{ skyId: string; entityId: string }> {
    const known = this.entities.get(iata);
    if (known) return known;

    const body = await this.get('/api/v1/flights/searchAirport', new URLSearchParams({ query: iata, locale: 'en-US' }), deadline);
    const list: any[] = Array.isArray(body?.data) ? body.data : [];
    const params = (e: any) => e?.navigation?.relevantFlightParams ?? {};
    const skyIdOf = (e: any) => String(e?.skyId ?? params(e).skyId ?? '').toUpperCase();
    const match =
      list.find((e) => skyIdOf(e) === iata && (e?.navigation?.entityType ?? 'AIRPORT') === 'AIRPORT') ??
      list.find((e) => skyIdOf(e) === iata);

    const entityId = match?.entityId ?? params(match).entityId ?? match?.navigation?.entityId;
    if (!match || !entityId) throw new Error(`skyscanner: no airport entity for ${iata}`);
    const resolved = { skyId: skyIdOf(match), entityId: String(entityId) };
    this.entities.set(iata, resolved);
    log.info({ iata, entityId: resolved.entityId }, 'skyscanner entity — add to KNOWN_ENTITIES to save a request');
    return resolved;
  }

  private async get(path: string, params: URLSearchParams, deadline: number, attempt = 1): Promise<any> {
    const host = config.RAPIDAPI_SKYSCANNER_HOST;
    const res = await fetch(`https://${host}${path}?${params}`, {
      headers: { 'X-RapidAPI-Key': config.RAPIDAPI_KEY, 'X-RapidAPI-Host': host },
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });

    const remaining = Number(res.headers.get('x-ratelimit-requests-remaining'));
    const resetSeconds = Number(res.headers.get('x-ratelimit-requests-reset')) || 3600;
    if (Number.isFinite(remaining) && res.headers.has('x-ratelimit-requests-remaining')) {
      log.info({ remaining, path }, 'skyscanner quota');
      if (remaining <= 0) this.blockedUntil = Date.now() + resetSeconds * 1000;
    }

    if (!res.ok) {
      // RapidAPI says why in the body: "You are not subscribed to this API"
      // (403), "rate limit per second" or "MONTHLY quota" (429). Keep it in
      // the error — it is the difference between "wait" and "upgrade".
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      const perSecond = res.status === 429 && !/month|quota/i.test(detail);
      if (res.status === 429 && !perSecond) this.blockedUntil = Date.now() + resetSeconds * 1000;
      if (perSecond && attempt < 3 && Date.now() + 2_500 < deadline) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        await sleep(Math.min(retryAfter || 1_100 * attempt, 2_000));
        return this.get(path, params, deadline, attempt + 1);
      }
      throw new Error(`skyscanner ${path} failed: HTTP ${res.status} ${detail}`.trim());
    }
    const json = (await res.json()) as any;
    if (json?.status === false) {
      throw new Error(`skyscanner ${path}: ${JSON.stringify(json.message ?? json.errors ?? 'error').slice(0, 200)}`);
    }
    return json;
  }
}

/**
 * A popular route returns a hundred-plus itineraries. Keep the ones any of the
 * three picks could come from — cheapest, quickest and Skyscanner's own "best"
 * order — so the session stays small and every label is still true.
 */
function keepUseful(offers: FlightOffer[]): FlightOffer[] {
  if (offers.length <= 80) return offers;
  const byPrice = [...offers].sort((a, b) => a.price.total - b.price.total).slice(0, 40);
  const byTime = [...offers].sort((a, b) => a.outbound.totalDurationMin - b.outbound.totalDurationMin).slice(0, 20);
  const kept = new Map<string, FlightOffer>();
  for (const o of [...byPrice, ...byTime, ...offers.slice(0, 30)]) kept.set(o.id, o);
  return [...kept.values()];
}

/** Skyscanner gives airport-local times with no offset; pin them to the airport's zone. */
function atAirport(local: unknown, iata: string): string | null {
  if (typeof local !== 'string' || !local) return null;
  const tz = getAirport(iata)?.tz;
  if (!tz) return local;
  const dt = DateTime.fromISO(local, { zone: tz });
  return dt.isValid ? dt.toISO({ suppressMilliseconds: true }) : local;
}

function mapSegment(s: any): Segment | null {
  // displayCode is the airline's IATA code. alternateId usually matches it but
  // not always — for IndiGo it is "49", which rendered flight "49-5341".
  const code = String(
    s?.marketingCarrier?.displayCode ?? s?.marketingCarrier?.alternateId ?? s?.operatingCarrier?.displayCode ?? '',
  ).toUpperCase();
  const from = String(s?.origin?.displayCode ?? s?.origin?.flightPlaceId ?? s?.origin?.id ?? '').toUpperCase();
  const to = String(s?.destination?.displayCode ?? s?.destination?.flightPlaceId ?? s?.destination?.id ?? '').toUpperCase();
  const departISO = atAirport(s?.departure, from);
  const arriveISO = atAirport(s?.arrival, to);
  if (!from || !to || !departISO || !arriveISO) return null;
  const number = String(s?.flightNumber ?? '').replace(/\D/g, '');
  return {
    carrierCode: code,
    carrierName: s?.marketingCarrier?.name ?? getAirline(code)?.name ?? code,
    flightNumber: code && number ? `${code}-${number}` : code || number,
    from,
    to,
    departISO,
    arriveISO,
    durationMin: Number(s?.durationInMinutes) || 0,
  };
}

/** A leg with no segment detail becomes one segment spanning the leg. */
function legAsSegment(leg: any): Segment | null {
  const carrier = leg?.carriers?.marketing?.[0] ?? {};
  const code = String(carrier.displayCode ?? carrier.alternateId ?? '').toUpperCase();
  const from = String(leg?.origin?.displayCode ?? leg?.origin?.id ?? '').toUpperCase();
  const to = String(leg?.destination?.displayCode ?? leg?.destination?.id ?? '').toUpperCase();
  const departISO = atAirport(leg?.departure, from);
  const arriveISO = atAirport(leg?.arrival, to);
  if (!from || !to || !departISO || !arriveISO) return null;
  return {
    carrierCode: code,
    carrierName: carrier.name ?? getAirline(code)?.name ?? code,
    flightNumber: code,
    from,
    to,
    departISO,
    arriveISO,
    durationMin: Number(leg?.durationInMinutes) || 0,
  };
}

function mapLeg(leg: any): Itin | null {
  const raw: any[] = Array.isArray(leg?.segments) ? leg.segments : [];
  const segments = raw.length ? raw.map(mapSegment) : [legAsSegment(leg)];
  if (!segments.length || segments.some((s) => s === null)) return null;
  const segs = segments as Segment[];

  const instant = (iso: string) => DateTime.fromISO(iso, { setZone: true });
  const layoverMin: number[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    layoverMin.push(Math.round(instant(segs[i + 1].departISO).diff(instant(segs[i].arriveISO), 'minutes').minutes));
  }
  const span = Math.round(instant(segs.at(-1)!.arriveISO).diff(instant(segs[0].departISO), 'minutes').minutes);
  const stops = Number.isInteger(leg?.stopCount) ? leg.stopCount : segs.length - 1;
  return {
    segments: segs,
    totalDurationMin: Number(leg?.durationInMinutes) || span,
    stops,
    layoverMin,
  };
}

export function mapItinerary(it: any, q: SearchQuery): FlightOffer | null {
  try {
    const legs: any[] = Array.isArray(it?.legs) ? it.legs : [];
    const total = Math.round(Number(it?.price?.raw ?? 0));
    if (!legs.length || !(total > 0)) return null;

    const outbound = mapLeg(legs[0]);
    if (!outbound) return null;
    const inbound = legs[1] ? mapLeg(legs[1]) : undefined;
    if (legs[1] && !inbound) return null;

    const airline = getAirline(outbound.segments[0].carrierCode);
    const paying = Math.max(1, q.adults + (q.children ?? 0));
    return {
      id: `sky-${String(it.id ?? `${outbound.segments[0].flightNumber}-${outbound.segments[0].departISO}`).replace(/[^A-Za-z0-9-]/g, '')}`,
      outbound,
      inbound: inbound ?? undefined,
      // Skyscanner prices the whole party; the per-head figure is derived.
      price: { total, perAdult: Math.round(total / paying), currency: 'INR' },
      cabin: q.cabin,
      refundable: Boolean(it?.farePolicy?.isCancellationAllowed),
      baggage: { cabinKg: airline?.cabinKg ?? 7, checkInKg: airline?.checkInKg ?? 15 },
      provider: 'skyscanner',
    };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'failed to map skyscanner itinerary');
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
