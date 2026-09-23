import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapItinerary, SkyscannerProvider } from '../src/flights/skyscanner.js';
import { applyFilters, topThree } from '../src/flights/ranking.js';
import type { SearchQuery } from '../src/flights/types.js';

/**
 * No network: the RapidAPI endpoints are stubbed with responses in the shape
 * the Sky Scrapper API documents, so the mapping and the polling are pinned
 * down without spending quota.
 */

const Q: SearchQuery = {
  origin: 'DEL',
  destination: 'GOI',
  departDate: '2026-10-02',
  adults: 2,
  cabin: 'ECONOMY',
  currency: 'INR',
};

// The shape of a real response: IndiGo's alternateId is Skyscanner's own "49",
// its displayCode the IATA "6E"; every airport carries its entity id.
const segment = (from: string, to: string, dep: string, arr: string, num: string, mins: number) => ({
  origin: { entityId: `e-${from}`, flightPlaceId: from, displayCode: from },
  destination: { entityId: `e-${to}`, flightPlaceId: to, displayCode: to },
  departure: dep,
  arrival: arr,
  durationInMinutes: mins,
  flightNumber: num,
  marketingCarrier: { id: -32213, name: 'IndiGo', alternateId: '49', displayCode: '6E' },
});

const NON_STOP = {
  id: '10957-2610020605--32213-0-10075-2610020835',
  price: { raw: 11480, formatted: '₹11,480' },
  legs: [
    {
      origin: { id: 'DEL', displayCode: 'DEL' },
      destination: { id: 'GOI', displayCode: 'GOI' },
      durationInMinutes: 150,
      stopCount: 0,
      departure: '2026-10-02T06:05:00',
      arrival: '2026-10-02T08:35:00',
      carriers: { marketing: [{ name: 'IndiGo', alternateId: '6E' }] },
      segments: [segment('DEL', 'GOI', '2026-10-02T06:05:00', '2026-10-02T08:35:00', '2112', 150)],
    },
  ],
  farePolicy: { isCancellationAllowed: false },
};

const ONE_STOP = {
  id: '10957-2610021400--32213-1-10075-2610022010',
  price: { raw: 8960, formatted: '₹8,960' },
  legs: [
    {
      origin: { id: 'DEL', displayCode: 'DEL' },
      destination: { id: 'GOI', displayCode: 'GOI' },
      durationInMinutes: 370,
      stopCount: 1,
      departure: '2026-10-02T14:00:00',
      arrival: '2026-10-02T20:10:00',
      carriers: { marketing: [{ name: 'IndiGo', alternateId: '6E' }] },
      segments: [
        segment('DEL', 'BOM', '2026-10-02T14:00:00', '2026-10-02T16:10:00', '5021', 130),
        segment('BOM', 'GOI', '2026-10-02T18:55:00', '2026-10-02T20:10:00', '334', 75),
      ],
    },
  ],
};

const SELF_TRANSFER = { ...ONE_STOP, id: 'self-1', price: { raw: 6100 }, isSelfTransfer: true };

describe('mapping a Skyscanner itinerary', () => {
  it('keeps real flight numbers, the airport clock and the whole-party fare', () => {
    const o = mapItinerary(ONE_STOP, Q)!;
    expect(o.provider).toBe('skyscanner');
    expect(o.price.total).toBe(8960);
    expect(o.price.perAdult).toBe(4480); // 2 adults
    expect(o.outbound.segments.map((s) => s.flightNumber)).toEqual(['6E-5021', '6E-334']);
    // Skyscanner sends local time with no offset; it is pinned to the airport.
    expect(o.outbound.segments[0].departISO).toBe('2026-10-02T14:00:00+05:30');
    expect(o.outbound.stops).toBe(1);
    expect(o.outbound.layoverMin).toEqual([165]);
    expect(o.outbound.totalDurationMin).toBe(370);
  });

  it('copes with a leg that has no segment detail', () => {
    const { segments: _drop, ...leg } = NON_STOP.legs[0];
    const o = mapItinerary({ ...NON_STOP, legs: [leg] }, Q)!;
    expect(o.outbound.segments).toHaveLength(1);
    expect(o.outbound.segments[0].from).toBe('DEL');
    expect(o.outbound.stops).toBe(0);
  });

  it('rejects an itinerary with no price rather than inventing one', () => {
    expect(mapItinerary({ ...NON_STOP, price: {} }, Q)).toBeNull();
    expect(mapItinerary({ price: { raw: 100 } }, Q)).toBeNull();
  });

  it('ranks and filters like any other offer', () => {
    const offers = [mapItinerary(NON_STOP, Q)!, mapItinerary(ONE_STOP, Q)!];
    expect(applyFilters(offers, { arriveWindow: { latest: '12:00' } }).map((o) => o.price.total)).toEqual([11480]);
    const picks = topThree(offers);
    expect(picks[0]).toMatchObject({ label: 'CHEAPEST' });
    expect(picks[0].offer.price.total).toBe(8960);
  });
});

describe('searching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs the two endpoints; returns the path of every call made, in order. */
  function stubApi() {
    const calls: { path: string; params: URLSearchParams }[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url);
        calls.push({ path: u.pathname, params: u.searchParams });
        if (u.pathname.endsWith('/searchAirport')) {
          const q = u.searchParams.get('query');
          // The real response nests the ids under navigation.relevantFlightParams.
          return json({
            status: true,
            data: [
              { navigation: { entityType: 'CITY', relevantFlightParams: { skyId: `${q}X`, entityId: 'wrong' } } },
              { navigation: { entityType: 'AIRPORT', relevantFlightParams: { skyId: q, entityId: `ent-${q}` } } },
            ],
          });
        }
        if (u.pathname.endsWith('/searchFlights')) {
          expect(u.searchParams.get('currency')).toBe('INR');
          return json({
            status: true,
            data: { context: { status: 'incomplete' }, itineraries: [NON_STOP, ONE_STOP, SELF_TRANSFER] },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    return calls;
  }

  const lookups = (calls: { path: string }[]) => calls.filter((c) => c.path.endsWith('/searchAirport'));

  it('returns live itineraries in a single call for known airports, minus self-transfers', async () => {
    const calls = stubApi();
    const offers = await new SkyscannerProvider().search(Q);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/flights/searchFlights']);
    expect(calls[0].params.get('originEntityId')).toBe('95673498');
    expect(offers.map((o) => o.price.total).sort((a, b) => a - b)).toEqual([8960, 11480]);
  });

  it('caches a search, so a repeat costs no quota', async () => {
    const calls = stubApi();
    const provider = new SkyscannerProvider();
    await provider.search(Q);
    const after = calls.length;
    await provider.search(Q);
    expect(calls.length).toBe(after);
  });

  it('looks up an unknown airport once, then remembers it', async () => {
    const calls = stubApi();
    const provider = new SkyscannerProvider();
    await provider.search({ ...Q, origin: 'CCU' });
    await provider.search({ ...Q, origin: 'CCU', departDate: '2026-10-03' });
    expect(lookups(calls)).toHaveLength(1);
    expect(calls.at(-1)!.params.get('originEntityId')).toBe('ent-CCU');
  });

  it('learns airport ids from the results, so later searches skip the lookup', async () => {
    const calls = stubApi();
    const provider = new SkyscannerProvider();
    await provider.search(Q); // the one-stop connects through BOM
    await provider.search({ ...Q, origin: 'BOM' });
    expect(lookups(calls)).toHaveLength(0);
    expect(calls.at(-1)!.params.get('originEntityId')).toBe('e-BOM');
  });

  it('fails loudly on an API error so the fallback can take over', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"quota"}', { status: 429 })));
    await expect(new SkyscannerProvider().search(Q)).rejects.toThrow(/429/);
  });

  it('stops calling once the monthly quota is gone', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"message":"You have exceeded the MONTHLY quota for Requests"}', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SkyscannerProvider();
    await expect(provider.search({ ...Q, origin: 'BOM' })).rejects.toThrow(/MONTHLY/);
    const used = fetchMock.mock.calls.length;
    await expect(provider.search({ ...Q, origin: 'BLR' })).rejects.toThrow(/quota used up/);
    expect(fetchMock.mock.calls.length).toBe(used);
  });

  it('keeps the reason RapidAPI gives, so the logs say what to fix', async () => {
    const body = '{"message":"You are not subscribed to this API."}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403 })));
    await expect(new SkyscannerProvider().search(Q)).rejects.toThrow(/403 .*not subscribed/);
  });

  it('waits out a per-second rate limit instead of giving up', async () => {
    const calls = stubApi();
    const real = globalThis.fetch as unknown as (url: string) => Promise<Response>;
    let limited = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!limited) {
          limited = true;
          return new Response('{"message":"You have exceeded the rate limit per second for your plan"}', { status: 429 });
        }
        return real(url);
      }),
    );
    const offers = await new SkyscannerProvider().search({ ...Q, origin: 'CCU' });
    expect(offers.length).toBeGreaterThan(0);
    expect(lookups(calls)).toHaveLength(1); // the retry, after the 429
  });

  it('looks airports up one at a time, not in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    stubApi();
    const real = globalThis.fetch as unknown as (url: string) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        try {
          return await real(url);
        } finally {
          inFlight--;
        }
      }),
    );
    await new SkyscannerProvider().search({ ...Q, origin: 'CCU', destination: 'MAA' });
    expect(peak).toBe(1);
  });
});
