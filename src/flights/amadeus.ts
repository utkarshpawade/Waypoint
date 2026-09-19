import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAirline } from './airlines.js';
import type { FlightOffer, FlightProvider, Itin, SearchQuery, Segment } from './types.js';

const log = logger.child({ mod: 'amadeus' });
const BASE = 'https://test.api.amadeus.com';

/**
 * Optional live inventory. The Amadeus *test* tier covers limited routes and
 * serves stale fares, which is why `mock` is the default and this is always
 * wrapped in the fallback decorator (see provider.ts).
 *
 * Every Amadeus shape is flattened in mapOffer() so their response format never
 * leaks past this file.
 */
export class AmadeusProvider implements FlightProvider {
  readonly name = 'amadeus';
  private token: { value: string; expiresAt: number } | null = null;

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${BASE}/v1/security/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.AMADEUS_CLIENT_ID,
        client_secret: config.AMADEUS_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`amadeus auth failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  async search(q: SearchQuery): Promise<FlightOffer[]> {
    const token = await this.accessToken();
    const params = new URLSearchParams({
      originLocationCode: q.origin,
      destinationLocationCode: q.destination,
      departureDate: q.departDate,
      adults: String(q.adults),
      currencyCode: 'INR',
      travelClass: q.cabin,
      max: '20',
    });
    if (q.returnDate) params.set('returnDate', q.returnDate);
    if (q.children) params.set('children', String(q.children));
    if (q.nonStopOnly) params.set('nonStop', 'true');

    const res = await fetch(`${BASE}/v2/shopping/flight-offers?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`amadeus search failed: ${res.status}`);
    const json = (await res.json()) as { data?: any[] };
    const offers = (json.data ?? []).map((d) => mapOffer(d, q)).filter(Boolean) as FlightOffer[];
    log.info({ count: offers.length, route: `${q.origin}-${q.destination}` }, 'amadeus offers');
    return offers;
  }
}

function parseDurationMin(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function mapItinerary(it: any): Itin {
  const segments: Segment[] = (it.segments ?? []).map((s: any) => ({
    carrierCode: s.carrierCode,
    carrierName: getAirline(s.carrierCode)?.name ?? s.carrierCode,
    flightNumber: `${s.carrierCode}-${s.number}`,
    from: s.departure?.iataCode,
    to: s.arrival?.iataCode,
    departISO: s.departure?.at,
    arriveISO: s.arrival?.at,
    durationMin: parseDurationMin(s.duration),
    aircraft: s.aircraft?.code,
  }));
  const layoverMin: number[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    layoverMin.push(
      Math.round((new Date(segments[i + 1].departISO).getTime() - new Date(segments[i].arriveISO).getTime()) / 60000),
    );
  }
  return { segments, totalDurationMin: parseDurationMin(it.duration), stops: segments.length - 1, layoverMin };
}

function mapOffer(d: any, q: SearchQuery): FlightOffer | null {
  try {
    const itineraries = d.itineraries ?? [];
    if (!itineraries.length) return null;
    const perAdult = Math.round(Number(d.travelerPricings?.[0]?.price?.total ?? d.price?.total ?? 0));
    const total = Math.round(Number(d.price?.grandTotal ?? d.price?.total ?? 0));
    const firstCarrier = itineraries[0].segments?.[0]?.carrierCode ?? '';
    const airline = getAirline(firstCarrier);
    return {
      id: `am-${d.id}`,
      outbound: mapItinerary(itineraries[0]),
      inbound: itineraries[1] ? mapItinerary(itineraries[1]) : undefined,
      price: { total, perAdult, currency: 'INR' },
      cabin: q.cabin,
      seatsRemaining: d.numberOfBookableSeats,
      refundable: false,
      baggage: {
        cabinKg: airline?.cabinKg ?? 7,
        checkInKg:
          d.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.includedCheckedBags?.weight ?? airline?.checkInKg ?? 15,
      },
      provider: 'amadeus',
    };
  } catch (err) {
    log.warn({ err }, 'failed to map amadeus offer');
    return null;
  }
}
