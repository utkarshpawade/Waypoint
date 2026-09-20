import { DateTime } from 'luxon';
import { config } from '../config.js';
import { findPlaces, resolvePlace, type Airport } from '../flights/airports.js';
import type { CabinClass, Preference } from '../flights/types.js';
import type { PassengerDraft, TripSlots } from '../db/types.js';

/**
 * Deterministic extraction. Two jobs:
 *
 *  1. It is the fallback when the LLM is rate-limited, unreachable or absent —
 *     Gemini's free tier has per-minute caps and the interviewer may test in
 *     bursts. Degraded but alive beats silent.
 *  2. Even when the LLM is healthy, *dates and cities are resolved here*, never
 *     by the model. "next friday" is arithmetic in Asia/Kolkata, not a thing to
 *     be guessed at, and a hallucinated IATA code is a wrong flight.
 */

export type Intent =
  | 'GREET'
  | 'PROVIDE_TRIP'
  | 'REFINE'
  | 'SELECT'
  | 'PROVIDE_PASSENGER'
  | 'CONFIRM'
  | 'DENY'
  | 'FAQ'
  | 'OUT_OF_SCOPE'
  | 'REQUEST_HUMAN'
  | 'RESTART'
  | 'UNKNOWN';

export interface RulesResult {
  intent: Intent;
  confidence: number;
  trip: Partial<TripSlots>;
  passenger: PassengerDraft;
  selection?: number;
  ambiguousPlaces: { role: 'origin' | 'destination' | 'unknown'; options: Airport[] }[];
  flags: {
    wantsHuman: boolean;
    frustrated: boolean;
    correction: boolean;
    pastDate: boolean;
    greeting: boolean;
  };
}

const zone = () => config.BUSINESS_TZ;

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Resolve a date expression to yyyy-mm-dd in the business timezone.
 * Returns null when there is no date in the text.
 */
export function parseDate(text: string, now: DateTime = DateTime.now().setZone(zone())): string | null {
  const t = text.toLowerCase();

  // Order matters here: "day after tomorrow" contains "tomorrow".
  if (/\bday after tomorrow\b/.test(t)) return now.plus({ days: 2 }).toISODate();
  if (/\b(today|tonight)\b/.test(t)) return now.toISODate();
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return now.plus({ days: 1 }).toISODate();

  const inDays = /\bin (\d{1,2}) days?\b/.exec(t);
  if (inDays) return now.plus({ days: Number(inDays[1]) }).toISODate();

  const inWeeks = /\bin (a|\d{1,2}) weeks?\b/.exec(t);
  if (inWeeks) return now.plus({ weeks: inWeeks[1] === 'a' ? 1 : Number(inWeeks[1]) }).toISODate();

  // ISO first — unambiguous.
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (iso) return safeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), now);

  // dd/mm or dd-mm (Indian convention), optional year.
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (dmy) {
    const year = dmy[3] ? Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : now.year;
    const d = safeDate(year, Number(dmy[2]), Number(dmy[1]), now);
    if (d) return rollForward(d, now, Boolean(dmy[3]));
  }

  // "27 sep" / "sep 27" / "27th september"
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(t);
  if (dayMonth && MONTHS[dayMonth[2]]) {
    const d = safeDate(now.year, MONTHS[dayMonth[2]], Number(dayMonth[1]), now);
    if (d) return rollForward(d, now, false);
  }
  const monthDay = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (monthDay && MONTHS[monthDay[1]]) {
    const d = safeDate(now.year, MONTHS[monthDay[1]], Number(monthDay[2]), now);
    if (d) return rollForward(d, now, false);
  }

  // "next friday" / "this friday" / bare "friday"
  const wd = /\b(next|this|coming)?\s*(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat|sunday|sun)\b/.exec(t);
  if (wd) {
    const target = WEEKDAYS[wd[2]];
    let d = now.plus({ days: (target - now.weekday + 7) % 7 });
    if (d.hasSame(now, 'day')) d = d.plus({ weeks: 1 });
    // "next friday" means the one after this coming week when today is late in the week.
    if (wd[1] === 'next' && d.diff(now, 'days').days < 7 && now.weekday >= 4) d = d.plus({ weeks: 1 });
    return d.toISODate();
  }

  // Bare ordinal: "on the 27th"
  const ord = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (ord) {
    const day = Number(ord[1]);
    if (day >= 1 && day <= 31) {
      const d = safeDate(now.year, now.month, day, now);
      if (d) return rollForward(d, now, false);
    }
  }

  const nextMonth = /\bnext month\b/.test(t);
  if (nextMonth) return now.plus({ months: 1 }).startOf('month').plus({ days: 9 }).toISODate();

  return null;
}

function safeDate(year: number, month: number, day: number, now: DateTime): string | null {
  const d = DateTime.fromObject({ year, month, day }, { zone: now.zone });
  return d.isValid ? d.toISODate() : null;
}

/** A bare "27 sep" in December means next year, not a date in the past. */
function rollForward(isoDate: string, now: DateTime, explicitYear: boolean): string {
  const d = DateTime.fromISO(isoDate, { zone: now.zone });
  if (explicitYear || d >= now.startOf('day')) return isoDate;
  return d.plus({ years: 1 }).toISODate()!;
}

export function isPastDate(iso: string, now: DateTime = DateTime.now().setZone(zone())): boolean {
  return DateTime.fromISO(iso, { zone: now.zone }) < now.startOf('day');
}

/** Extract origin/destination, using "from X to Y" shape where present. */
export function extractRoute(text: string): {
  origin?: string;
  destination?: string;
  ambiguous: { role: 'origin' | 'destination' | 'unknown'; options: Airport[] }[];
} {
  const lower = text.toLowerCase();
  const ambiguous: { role: 'origin' | 'destination' | 'unknown'; options: Airport[] }[] = [];

  // Directional phrasing wins: "from bangalore to dubai", "blr - dxb", "bangalore->dubai"
  const directional =
    /\bfrom\s+([a-z ]{3,25}?)\s+(?:to|→|->|-)\s+([a-z ]{3,25})\b/.exec(lower) ??
    /\b([a-z]{3,20})\s*(?:to|→|->)\s*([a-z ]{3,25})\b/.exec(lower);
  if (directional) {
    const o = resolvePlace(directional[1]);
    const d = resolvePlace(directional[2]);
    const out: { origin?: string; destination?: string; ambiguous: typeof ambiguous } = { ambiguous };
    if (o.length === 1) out.origin = o[0].iata;
    else if (o.length > 1) ambiguous.push({ role: 'origin', options: o });
    if (d.length === 1) out.destination = d[0].iata;
    else if (d.length > 1) ambiguous.push({ role: 'destination', options: d });
    if (out.origin || out.destination || ambiguous.length) return out;
  }

  const fromOnly = /\bfrom\s+([a-z ]{3,25}?)(?:\s+(?:on|at|next|tomorrow|today|in|for|,|\.)|$)/.exec(lower);
  const toOnly = /\b(?:to|going to|fly to|flying to|travel to)\s+([a-z ]{3,25}?)(?:\s+(?:on|at|next|tomorrow|today|in|for|,|\.)|$)/.exec(lower);

  const result: { origin?: string; destination?: string; ambiguous: typeof ambiguous } = { ambiguous };
  if (fromOnly) {
    const o = resolvePlace(fromOnly[1]);
    if (o.length === 1) result.origin = o[0].iata;
    else if (o.length > 1) ambiguous.push({ role: 'origin', options: o });
  }
  if (toOnly) {
    const d = resolvePlace(toOnly[1]);
    if (d.length === 1) result.destination = d[0].iata;
    else if (d.length > 1) ambiguous.push({ role: 'destination', options: d });
  }
  if (result.origin || result.destination || ambiguous.length) return result;

  // No directional words — fall back to order of appearance.
  const found = findPlaces(text);
  if (found.length >= 2) {
    const [a, b] = found;
    if (a.airports.length === 1) result.origin = a.airports[0].iata;
    else ambiguous.push({ role: 'origin', options: a.airports });
    if (b.airports.length === 1) result.destination = b.airports[0].iata;
    else ambiguous.push({ role: 'destination', options: b.airports });
  } else if (found.length === 1) {
    if (found[0].airports.length === 1) result.destination = found[0].airports[0].iata;
    else ambiguous.push({ role: 'unknown', options: found[0].airports });
  }
  return result;
}

const CABIN_PATTERNS: [RegExp, CabinClass][] = [
  [/\b(premium economy|prem eco)\b/, 'PREMIUM_ECONOMY'],
  [/\b(business|biz class|club)\b/, 'BUSINESS'],
  [/\bfirst class\b/, 'FIRST'],
  [/\b(economy|eco|coach)\b/, 'ECONOMY'],
];

const PREFERENCE_PATTERNS: [RegExp, Preference][] = [
  [/\b(cheapest|cheaper|cheap|budget|lowest fare|least expensive|save money)\b/, 'CHEAPEST'],
  [/\b(fastest|quickest|shortest|least time|quick)\b/, 'FASTEST'],
  [/\b(comfortable|comfort|best airline|premium|nicest)\b/, 'COMFORT'],
  [/\b(best value|value for money|balanced|best option)\b/, 'BEST_VALUE'],
];

export function extractTripSlots(text: string, now?: DateTime): Partial<TripSlots> {
  const lower = text.toLowerCase();
  const slots: Partial<TripSlots> = {};

  const route = extractRoute(text);
  if (route.origin) slots.origin = route.origin;
  if (route.destination) slots.destination = route.destination;

  // Return date first, so its date expression is not consumed as the departure.
  const returnMatch = /\b(?:return|returning|coming back|back|till|until)\s+(?:on\s+)?(.{3,25})/.exec(lower);
  if (returnMatch) {
    const rd = parseDate(returnMatch[1], now);
    if (rd) {
      slots.returnDate = rd;
      slots.tripType = 'ROUND_TRIP';
    }
  }
  const departSource = returnMatch ? lower.slice(0, returnMatch.index) : lower;
  const dd = parseDate(departSource, now);
  if (dd) slots.departDate = dd;

  if (/\b(round trip|return ticket|roundtrip|both ways|two way)\b/.test(lower)) slots.tripType = 'ROUND_TRIP';
  if (/\b(one way|oneway|single)\b/.test(lower)) slots.tripType = 'ONE_WAY';

  // Passengers. Guard against eating "2 stops" or a price.
  const adults = /\b(\d{1,2})\s*(?:adults?|pax|passengers?|people|persons?|travell?ers?|of us|seats?)\b/.exec(lower);
  if (adults) slots.adults = clamp(Number(adults[1]), 1, 9);
  // "me and my wife" contains "me", so the pair check has to come first.
  else if (/\b(me and my (wife|husband|partner|friend)|couple|two of us|both of us)\b/.test(lower)) slots.adults = 2;
  else if (/\b(just|only)?\s*(me|myself|solo|alone)\b/.test(lower)) slots.adults = 1;

  const children = /\b(\d{1,2})\s*(?:child|children|kids?)\b/.exec(lower);
  if (children) slots.children = clamp(Number(children[1]), 0, 8);
  else if (/\b(a|one)\s+(child|kid)\b/.test(lower)) slots.children = 1;

  const infants = /\b(\d{1,2})\s*(?:infants?|babies|baby)\b/.exec(lower);
  if (infants) slots.infants = clamp(Number(infants[1]), 0, 4);
  else if (/\b(an?|one)\s+(infant|baby)\b/.test(lower)) slots.infants = 1;

  for (const [re, cabin] of CABIN_PATTERNS) {
    if (re.test(lower)) {
      slots.cabin = cabin;
      break;
    }
  }
  for (const [re, pref] of PREFERENCE_PATTERNS) {
    if (re.test(lower)) {
      slots.preference = pref;
      break;
    }
  }

  const budget = extractBudget(lower);
  if (budget) slots.budgetMax = budget;

  if (/\b(non[- ]?stop|nonstop|direct|no (layover|stops?|connection))\b/.test(lower)) slots.nonStopOnly = true;
  if (/\b(any|with) (stops?|layovers?)\b|\bstops are (fine|ok)\b/.test(lower)) slots.nonStopOnly = false;

  const win = extractDepartWindow(lower);
  if (win) slots.departWindow = win;

  return slots;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function extractBudget(lower: string): number | undefined {
  const m =
    /\b(?:under|below|less than|within|max|maximum|upto|up to|budget of|budget)\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|l)?\b/.exec(
      lower,
    ) ?? /(?:rs\.?|inr|₹)\s*([\d,]+)\s*(k|thousand|lakh|lakhs|l)?\s*(?:or less|max|budget)/.exec(lower);
  if (!m) return undefined;
  let value = Number(m[1].replace(/,/g, ''));
  const unit = m[2];
  if (unit === 'k' || unit === 'thousand') value *= 1000;
  else if (unit === 'lakh' || unit === 'lakhs' || unit === 'l') value *= 100_000;
  return value >= 500 ? Math.round(value) : undefined;
}

export function extractDepartWindow(lower: string): { earliest?: string; latest?: string } | undefined {
  if (/\b(early morning|red[- ]?eye)\b/.test(lower)) return { earliest: '00:00', latest: '08:00' };
  if (/\bmorning\b/.test(lower)) return { earliest: '05:00', latest: '12:00' };
  if (/\bafternoon\b/.test(lower)) return { earliest: '12:00', latest: '17:00' };
  if (/\bevening\b/.test(lower)) return { earliest: '17:00', latest: '21:00' };
  if (/\b(night|late)\b/.test(lower)) return { earliest: '20:00', latest: '23:59' };

  const after = /\bafter\s+(\d{1,2})\s*(am|pm)?\b/.exec(lower);
  const before = /\bbefore\s+(\d{1,2})\s*(am|pm)?\b/.exec(lower);
  if (after || before) {
    const w: { earliest?: string; latest?: string } = {};
    if (after) w.earliest = to24h(Number(after[1]), after[2]);
    if (before) w.latest = to24h(Number(before[1]), before[2]);
    return w;
  }
  return undefined;
}

function to24h(hour: number, meridiem?: string): string {
  let h = hour;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (!meridiem && h <= 7) h += 12; // "before 6" almost always means 6pm
  return `${String(h % 24).padStart(2, '0')}:00`;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** The first email address in a message, lowercased. */
export function extractEmail(text: string): string | null {
  return EMAIL_RE.exec(text)?.[0]?.toLowerCase() ?? null;
}
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?[6-9]\d{9}\b/;
const PASSPORT_RE = /\b([A-PR-WY][0-9]{7})\b/i;

/**
 * Words that belong to a *different* passenger field. Stripped before the
 * bare-line name heuristic runs, so volunteering several fields in one message
 * doesn't glue them onto the name.
 */
const FIELD_WORDS_RE =
  /\b(male|female|man|woman|mr|mrs|ms|miss|dr|gender|dob|date of birth|born|email|e-?mail|phone|mobile|number|contact|passport|expires?|expiry|valid|till|until|nationality|citizen|indian|american|british|and|my|name|is|this)\b/gi;

export function extractPassengerFields(text: string, now?: DateTime): PassengerDraft {
  const draft: PassengerDraft = {};
  const lower = text.toLowerCase();

  const email = EMAIL_RE.exec(text);
  if (email) draft.email = email[0].toLowerCase();

  const phone = PHONE_RE.exec(text.replace(/[()\s-]/g, ' '));
  if (phone) draft.phone = phone[0].replace(/\s/g, '');

  const passport = PASSPORT_RE.exec(text);
  if (passport) draft.passportNo = passport[1].toUpperCase();

  if (/\b(male|man|mr\.?|m)\b/.test(lower) && !/\bfemale\b/.test(lower)) draft.gender = 'M';
  if (/\b(female|woman|ms\.?|mrs\.?|f)\b/.test(lower)) draft.gender = 'F';

  // A date of birth is a date in the past; departure dates are in the future.
  const dob = parseDobLike(text, now);
  if (dob) draft.dateOfBirth = dob;

  const named = /\b(?:name is|name:|i am|i'm|this is|full name)\s+([a-z][a-z .'-]{2,60})/i.exec(text);
  if (named) draft.fullName = titleCase(named[1].trim());
  else {
    // A bare line of 2-4 alphabetic words, with nothing else in it, is a name.
    // People volunteer several fields at once ("Priya Sharma 03/11/1994 female"),
    // so every other field's own vocabulary has to come out first — otherwise
    // the passenger is booked as "Priya Sharma Female".
    const stripped = text
      .replace(EMAIL_RE, ' ')
      .replace(PHONE_RE, ' ')
      .replace(PASSPORT_RE, ' ')
      .replace(/\b\d[\d/.-]*\b/g, ' ')
      .replace(FIELD_WORDS_RE, ' ')
      .trim();
    const words = stripped.split(/\s+/).filter(Boolean);
    if (
      words.length >= 2 &&
      words.length <= 4 &&
      words.every((w) => /^[a-z][a-z.'-]{1,20}$/i.test(w)) &&
      !/\b(yes|no|ok|okay|thanks|thank you|please|book|flight|option|cheaper|morning|evening)\b/i.test(stripped)
    ) {
      draft.fullName = titleCase(stripped);
    }
  }

  const nationality = /\b(?:nationality|citizen of|passport from)\s*:?\s*([a-z ]{3,20})/i.exec(text);
  if (nationality) draft.nationality = titleCase(nationality[1].trim());
  else if (/\bindian\b/i.test(text)) draft.nationality = 'Indian';

  const expiry = /\b(?:expir\w*|valid till|valid until)\s*:?\s*(.{3,20})/i.exec(text);
  if (expiry) {
    const d = parseDate(expiry[1], now);
    if (d) draft.passportExpiry = d;
  }

  return draft;
}

/** Dates written as dd/mm/yyyy or "12 March 1990" that fall in the past. */
function parseDobLike(text: string, now: DateTime = DateTime.now().setZone(zone())): string | undefined {
  const explicit = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(text);
  if (explicit) {
    const d = DateTime.fromObject(
      { day: Number(explicit[1]), month: Number(explicit[2]), year: Number(explicit[3]) },
      { zone: now.zone },
    );
    if (d.isValid && d < now) return d.toISODate()!;
  }
  const iso = /\b(19\d{2}|20[0-2]\d)-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) {
    const d = DateTime.fromISO(iso[0], { zone: now.zone });
    if (d.isValid && d < now) return d.toISODate()!;
  }
  const worded = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s+(19\d{2}|20[0-2]\d)\b/i.exec(text);
  if (worded && MONTHS[worded[2].toLowerCase()]) {
    const d = DateTime.fromObject(
      { day: Number(worded[1]), month: MONTHS[worded[2].toLowerCase()], year: Number(worded[3]) },
      { zone: now.zone },
    );
    if (d.isValid && d < now) return d.toISODate()!;
  }
  return undefined;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const HUMAN_RE =
  /\b(human|agent|real person|representative|customer (care|service|support)|talk to (someone|a person|somebody)|speak to (someone|a person|somebody)|escalate|supervisor|manager)\b/i;

const FRUSTRATION_RE =
  /\b(useless|stupid|terrible|awful|ridiculous|frustrat\w*|annoy\w*|wtf|not working|you (don'?t|dont) understand|i already (said|told)|for the (third|3rd|last) time|waste of time)\b|[!?]{3,}/i;

const CORRECTION_RE = /\b(no,|nope|not that|i (said|meant)|actually|change that|wrong|instead)\b/i;

const GREET_RE = /^\s*(hi+|hey+|hello+|yo|good (morning|afternoon|evening)|namaste|hola)\b/i;

const CONFIRM_RE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|do it|book it|proceed|correct|right|👍|✅)\b/i;
const DENY_RE = /^\s*(no|nope|nah|cancel|stop|don'?t|wait|not yet|change)\b/i;

const SELECTION_RE = /^\s*(?:option\s*)?([123])\s*$|^\s*(?:option|number|pick|choose|take|go with|book|select)?\s*(?:the\s+)?(first|second|third|1st|2nd|3rd|one|two|three)\b/i;

const ORDINALS: Record<string, number> = {
  '1': 1, '2': 2, '3': 3, first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3,
};

export function extractSelection(text: string): number | undefined {
  const m = SELECTION_RE.exec(text.trim());
  if (m) {
    const key = (m[1] ?? m[2] ?? '').toLowerCase();
    return ORDINALS[key];
  }
  if (/\bcheapest (one|option)?\b/i.test(text)) return 1;
  if (/\bfastest (one|option)?\b/i.test(text)) return 2;
  if (/\b(best value|balanced|middle) (one|option)?\b/i.test(text)) return 3;
  return undefined;
}

const FAQ_RE =
  /\b(baggage|luggage|check[- ]?in|visa|passport|refund|cancel\w*|seat|meal|food|infant|baby|web check|how early|allowance|pay|payment)\b/i;

const OUT_OF_SCOPE_RE =
  /\b(hotel|cab|taxi|train|bus|submarine|car rental|restaurant|weather|movie|pizza|insurance|tour package|cruise)\b/i;

/** Words that mean the message is still about flying, even if it names a hotel. */
const FLIGHT_CONTEXT_RE = /\b(flight|flights|fly|flying|fare|fares|airline|airport|ticket|boarding)\b/i;

export function interpretRules(
  text: string,
  ctx: { state: string; expectingPassenger?: boolean; hasOffers?: boolean },
  now?: DateTime,
): RulesResult {
  const trimmed = text.trim();
  const trip = extractTripSlots(trimmed, now);
  const route = extractRoute(trimmed);
  const passenger = ctx.expectingPassenger ? extractPassengerFields(trimmed, now) : {};
  const selection = ctx.hasOffers ? extractSelection(trimmed) : undefined;

  const flags = {
    wantsHuman: HUMAN_RE.test(trimmed),
    frustrated: FRUSTRATION_RE.test(trimmed),
    correction: CORRECTION_RE.test(trimmed),
    pastDate: Boolean(trip.departDate && isPastDate(trip.departDate, now)),
    greeting: GREET_RE.test(trimmed),
  };

  const filledTrip = Object.keys(trip).length;
  const filledPassenger = Object.values(passenger).filter(Boolean).length;

  let intent: Intent = 'UNKNOWN';
  let confidence = 0.3;

  if (flags.wantsHuman) {
    intent = 'REQUEST_HUMAN';
    confidence = 0.95;
  } else if (selection !== undefined) {
    intent = 'SELECT';
    confidence = 0.9;
  } else if (filledPassenger >= 1) {
    intent = 'PROVIDE_PASSENGER';
    confidence = filledPassenger >= 2 ? 0.85 : 0.7;
  } else if (/\b(start over|restart|new search|different trip|forget that)\b/i.test(trimmed)) {
    intent = 'RESTART';
    confidence = 0.9;
  } else if (OUT_OF_SCOPE_RE.test(trimmed) && !FLIGHT_CONTEXT_RE.test(trimmed)) {
    // "book me a hotel in dubai" names a city we recognise — that does not make
    // it a flight request. Out-of-scope has to win over slot extraction.
    intent = 'OUT_OF_SCOPE';
    confidence = 0.85;
  } else if (filledTrip >= 1 && (route.origin || route.destination || trip.departDate)) {
    intent = 'PROVIDE_TRIP';
    confidence = filledTrip >= 3 ? 0.9 : filledTrip >= 2 ? 0.75 : 0.6;
  } else if (ctx.hasOffers && filledTrip >= 1) {
    intent = 'REFINE';
    confidence = 0.7;
  } else if (CONFIRM_RE.test(trimmed)) {
    intent = 'CONFIRM';
    confidence = 0.85;
  } else if (DENY_RE.test(trimmed)) {
    intent = 'DENY';
    confidence = 0.8;
  } else if (FAQ_RE.test(trimmed)) {
    intent = 'FAQ';
    confidence = 0.6;
  } else if (OUT_OF_SCOPE_RE.test(trimmed)) {
    intent = 'OUT_OF_SCOPE';
    confidence = 0.8;
  } else if (flags.greeting) {
    intent = 'GREET';
    confidence = 0.9;
  }

  // A refinement is a trip change made while offers are on the table.
  if (ctx.hasOffers && intent === 'PROVIDE_TRIP' && !route.origin && !route.destination) {
    intent = 'REFINE';
  }
  if (ctx.hasOffers && intent === 'UNKNOWN' && filledTrip >= 1) {
    intent = 'REFINE';
    confidence = 0.65;
  }

  return { intent, confidence, trip, passenger, selection, ambiguousPlaces: route.ambiguous, flags };
}
