import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Airport {
  iata: string;
  city: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
  aliases: string[];
  /**
   * The airport a bare city name means when the city has several. Set only
   * where one is the obvious default (Goa → GOI); left unset where the choice
   * is genuinely the traveller's (London → LHR or LGW), which is what makes
   * the disambiguation question worth asking.
   */
  primary?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

export const AIRPORTS: Airport[] = JSON.parse(readFileSync(join(dataDir, 'airports.json'), 'utf8'));

const byIata = new Map<string, Airport>(AIRPORTS.map((a) => [a.iata, a]));

/** term (lowercased) -> airports. A city term like "london" maps to several. */
const index = new Map<string, Airport[]>();
function addTerm(term: string, a: Airport) {
  const key = normalise(term);
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.includes(a)) list.push(a);
  index.set(key, list);
}
for (const a of AIRPORTS) {
  addTerm(a.iata, a);
  addTerm(a.city, a);
  for (const al of a.aliases) addTerm(al, a);
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getAirport(iata: string): Airport | undefined {
  return byIata.get(iata.toUpperCase());
}

/**
 * Resolve a user-typed place to airports.
 * Returns [] for unknown, [one] for resolved, [many] when the city has several
 * airports and the caller must disambiguate ("London" → LHR / LGW).
 */
export function resolvePlace(term: string): Airport[] {
  const key = normalise(term);
  if (!key) return [];
  const exact = index.get(key);
  if (exact) return preferPrimary(exact);

  // Try the longest matching known term contained in the phrase, so
  // "flying from bangalore tomorrow" still resolves.
  const words = key.split(' ');
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      const hit = index.get(phrase);
      if (hit) return preferPrimary(hit);
    }
  }
  return [];
}

/** Collapse a multi-airport city to its default, when it has one. */
function preferPrimary(matches: Airport[]): Airport[] {
  if (matches.length < 2) return matches;
  const primaries = matches.filter((a) => a.primary);
  return primaries.length === 1 ? primaries : matches;
}

/** Every airport term mentioned in a free-text message, in order of appearance. */
export function findPlaces(text: string): { term: string; airports: Airport[]; at: number }[] {
  const key = normalise(text);
  const words = key.split(' ');
  const out: { term: string; airports: Airport[]; at: number }[] = [];
  const used = new Set<number>();
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      if ([...Array(len).keys()].some((k) => used.has(i + k))) continue;
      const phrase = words.slice(i, i + len).join(' ');
      const hit = index.get(phrase);
      if (hit) {
        // Ignore 2-letter noise and words that are also common English.
        if (phrase.length < 3) continue;
        for (let k = 0; k < len; k++) used.add(i + k);
        out.push({ term: phrase, airports: preferPrimary(hit), at: i });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const R_KM = 6371;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export function distanceBetween(originIata: string, destIata: string): number {
  const a = getAirport(originIata);
  const b = getAirport(destIata);
  if (!a || !b) return 1500;
  return haversineKm(a, b);
}

export function isInternational(originIata: string, destIata: string): boolean {
  const a = getAirport(originIata);
  const b = getAirport(destIata);
  if (!a || !b) return false;
  return a.country !== b.country;
}
