import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Airline {
  code: string;
  name: string;
  country: string;
  /**
   * Hand-assigned 0.6–0.95 proxy for service quality / on-time performance.
   * It is STATIC EDITORIAL DATA, not a live OTP feed — documented as such in
   * the README, and it only ever contributes 5–15% of the ranking score.
   */
  qualityScore: number;
  scope: ('domestic' | 'shorthaul' | 'longhaul')[];
  cabinKg: number;
  checkInKg: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const AIRLINES: Airline[] = JSON.parse(readFileSync(join(here, '..', '..', 'data', 'airlines.json'), 'utf8'));

const byCode = new Map(AIRLINES.map((a) => [a.code, a]));

export function getAirline(code: string): Airline | undefined {
  return byCode.get(code.toUpperCase());
}

export function qualityScore(code: string): number {
  return byCode.get(code.toUpperCase())?.qualityScore ?? 0.7;
}

export function airlinesFor(opts: {
  domestic: boolean;
  distanceKm: number;
  originCountry: string;
  destCountry: string;
}): Airline[] {
  const scope = opts.domestic ? 'domestic' : opts.distanceKm > 4500 ? 'longhaul' : 'shorthaul';
  const pool = AIRLINES.filter((a) => a.scope.includes(scope as any));
  if (opts.domestic) return pool.filter((a) => a.country === 'IN');
  // On an international route, prefer carriers of either endpoint plus the big
  // connecting hubs — the same set a real search would surface.
  const relevant = pool.filter(
    (a) =>
      a.country === opts.originCountry ||
      a.country === opts.destCountry ||
      ['AE', 'QA', 'SG', 'TR', 'OM', 'BH', 'LK'].includes(a.country),
  );
  return relevant.length >= 4 ? relevant : pool;
}

export { AIRLINES };
