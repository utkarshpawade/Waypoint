import { config } from '../config.js';
import { logger } from '../logger.js';
import { AmadeusProvider } from './amadeus.js';
import { MockProvider } from './mock.js';
import { SkyscannerProvider } from './skyscanner.js';
import type { FlightOffer, FlightProvider, SearchQuery } from './types.js';

const log = logger.child({ mod: 'flights' });

/**
 * Wraps a live provider so a third-party outage can never break a demo:
 * any error or timeout falls back to the deterministic mock inventory.
 */
class FallbackProvider implements FlightProvider {
  readonly name: string;
  constructor(
    private primary: FlightProvider,
    private backup: FlightProvider,
    private timeoutMs = 5000,
  ) {
    this.name = `${primary.name}+fallback`;
  }

  async search(q: SearchQuery): Promise<FlightOffer[]> {
    try {
      const offers = await withTimeout(this.primary.search(q), this.timeoutMs);
      if (offers.length) return offers;
      log.warn({ provider: this.primary.name }, 'provider_fallback: empty result');
    } catch (err) {
      log.warn({ err: (err as Error).message, provider: this.primary.name }, 'provider_fallback: error');
    }
    return this.backup.search(q);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

let provider: FlightProvider | null = null;

export function getFlightProvider(): FlightProvider {
  if (!provider) {
    const mock = new MockProvider();
    if (config.FLIGHT_PROVIDER === 'skyscanner' && config.RAPIDAPI_KEY) {
      // Skyscanner polls airlines and agents, so give it longer than Amadeus;
      // the user has already been told "Searching fares…" by then.
      provider = new FallbackProvider(new SkyscannerProvider(15_000), mock, 18_000);
      log.info('flight provider: skyscanner via rapidapi (mock fallback)');
    } else if (config.FLIGHT_PROVIDER === 'amadeus' && config.AMADEUS_CLIENT_ID && config.AMADEUS_CLIENT_SECRET) {
      provider = new FallbackProvider(new AmadeusProvider(), mock);
      log.info('flight provider: amadeus (mock fallback)');
    } else {
      if (config.FLIGHT_PROVIDER !== 'mock') {
        log.warn({ wanted: config.FLIGHT_PROVIDER }, 'live flight provider selected but its keys are missing — using mock');
      }
      provider = mock;
      log.info('flight provider: mock');
    }
  }
  return provider;
}

export function setFlightProvider(p: FlightProvider): void {
  provider = p;
}
