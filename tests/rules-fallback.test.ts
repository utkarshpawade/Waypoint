import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  extractBudget,
  extractDepartWindow,
  extractPassengerFields,
  extractTimeWindows,
  extractRoute,
  extractSelection,
  extractTripSlots,
  interpretRules,
  isPastDate,
  parseDate,
} from '../src/llm/rules-fallback.js';

// A fixed "now" so every date assertion is stable: Saturday 19 September 2026.
const NOW = DateTime.fromISO('2026-09-19T14:00:00', { zone: 'Asia/Kolkata' });

describe('date resolution', () => {
  it('handles relative expressions', () => {
    expect(parseDate('today', NOW)).toBe('2026-09-19');
    expect(parseDate('tomorrow', NOW)).toBe('2026-09-20');
    expect(parseDate('day after tomorrow', NOW)).toBe('2026-09-21');
    expect(parseDate('in 3 days', NOW)).toBe('2026-09-22');
    expect(parseDate('in 2 weeks', NOW)).toBe('2026-10-03');
  });

  it('resolves weekdays forward, never into the past', () => {
    // NOW is a Saturday.
    expect(parseDate('monday', NOW)).toBe('2026-09-21');
    expect(parseDate('friday', NOW)).toBe('2026-09-25');
    // "next friday" late in the week means the following week's Friday.
    expect(parseDate('next friday', NOW)).toBe('2026-10-02');
  });

  it('parses explicit dates in several shapes', () => {
    expect(parseDate('2026-12-15', NOW)).toBe('2026-12-15');
    expect(parseDate('15/12/2026', NOW)).toBe('2026-12-15');
    expect(parseDate('27 sep', NOW)).toBe('2026-09-27');
    expect(parseDate('sep 27', NOW)).toBe('2026-09-27');
    expect(parseDate('27th september', NOW)).toBe('2026-09-27');
    expect(parseDate('on the 27th', NOW)).toBe('2026-09-27');
  });

  it('rolls a bare day-month into next year when it has already passed', () => {
    expect(parseDate('5 jan', NOW)).toBe('2027-01-05');
    expect(parseDate('1 march', NOW)).toBe('2027-03-01');
  });

  it('returns null when there is no date at all', () => {
    expect(parseDate('bangalore to dubai', NOW)).toBeNull();
    expect(parseDate('two adults economy', NOW)).toBeNull();
  });

  it('identifies past dates', () => {
    expect(isPastDate('2026-09-18', NOW)).toBe(true);
    expect(isPastDate('2026-09-19', NOW)).toBe(false);
    expect(isPastDate('2026-09-20', NOW)).toBe(false);
  });
});

describe('route extraction', () => {
  it('reads "from X to Y"', () => {
    const r = extractRoute('I need a flight from bangalore to dubai');
    expect(r.origin).toBe('BLR');
    expect(r.destination).toBe('DXB');
  });

  it('reads bare "X to Y" and aliases', () => {
    expect(extractRoute('bombay to goa').origin).toBe('BOM');
    expect(extractRoute('blr to dxb').destination).toBe('DXB');
    expect(extractRoute('calcutta to bengaluru').origin).toBe('CCU');
  });

  it('flags a city with more than one airport instead of guessing', () => {
    const r = extractRoute('delhi to london');
    expect(r.origin).toBe('DEL');
    expect(r.destination).toBeUndefined();
    expect(r.ambiguous[0].role).toBe('destination');
    expect(r.ambiguous[0].options.map((a) => a.iata).sort()).toEqual(['LGW', 'LHR']);
  });

  it('treats a lone destination as a destination', () => {
    expect(extractRoute('I want to go to singapore').destination).toBe('SIN');
  });

  it('returns nothing for text with no places in it', () => {
    const r = extractRoute('what is the baggage allowance');
    expect(r.origin).toBeUndefined();
    expect(r.destination).toBeUndefined();
  });
});

describe('trip slots', () => {
  it('pulls route, date and passengers out of one sentence', () => {
    const s = extractTripSlots('bangalore to dubai next friday, 2 adults', NOW);
    expect(s).toMatchObject({ origin: 'BLR', destination: 'DXB', departDate: '2026-10-02', adults: 2 });
  });

  it('separates the return date from the departure date', () => {
    const s = extractTripSlots('delhi to goa on 5 december returning on 12 december', NOW);
    expect(s.departDate).toBe('2026-12-05');
    expect(s.returnDate).toBe('2026-12-12');
    expect(s.tripType).toBe('ROUND_TRIP');
  });

  it('reads cabin, preference and non-stop', () => {
    const s = extractTripSlots('business class, cheapest, non-stop only', NOW);
    expect(s.cabin).toBe('BUSINESS');
    expect(s.preference).toBe('CHEAPEST');
    expect(s.nonStopOnly).toBe(true);
  });

  it('counts children and infants separately from adults', () => {
    const s = extractTripSlots('2 adults 1 child and an infant', NOW);
    expect(s).toMatchObject({ adults: 2, children: 1, infants: 1 });
  });

  it('understands the ways people say they are travelling alone or as a pair', () => {
    expect(extractTripSlots('just me', NOW).adults).toBe(1);
    expect(extractTripSlots('me and my wife', NOW).adults).toBe(2);
  });
});

describe('budget and time windows', () => {
  it('parses Indian money shorthand', () => {
    expect(extractBudget('under 30k')).toBe(30_000);
    expect(extractBudget('below ₹25,000')).toBe(25_000);
    expect(extractBudget('max 1.5 lakh')).toBe(150_000);
    expect(extractBudget('budget of rs 40000')).toBe(40_000);
    expect(extractBudget('flights to dubai')).toBeUndefined();
  });

  it('parses time-of-day preferences', () => {
    expect(extractDepartWindow('morning flights')).toEqual({ earliest: '05:00', latest: '12:00' });
    expect(extractDepartWindow('something in the evening')).toEqual({ earliest: '17:00', latest: '21:00' });
    expect(extractDepartWindow('after 6pm')).toEqual({ earliest: '18:00' });
    // With no arrival word, a bare time bound is about departure.
    expect(extractDepartWindow('before noon')).toEqual({ latest: '12:00' });
  });

  it('tells arrival constraints from departure ones', () => {
    // Every phrasing from the WhatsApp conversation that exposed this.
    expect(extractTimeWindows('for tomorrow morning')).toEqual({ depart: { earliest: '05:00', latest: '12:00' } });
    expect(extractTimeWindows('give me only non stop flights and reaching before noon')).toEqual({
      arrive: { latest: '12:00' },
    });
    expect(extractTimeWindows('i need a flight reaching before noon')).toEqual({ arrive: { latest: '12:00' } });
    expect(extractTimeWindows('i need to reach before noon')).toEqual({ arrive: { latest: '12:00' } });
    expect(extractTimeWindows('i need a direct flight reaching goa before noon')).toEqual({
      arrive: { latest: '12:00' },
    });

    expect(extractTimeWindows('be in goa by 10:30am')).toEqual({ arrive: { latest: '10:30' } });
    expect(extractTimeWindows('leave after 6pm, land by 11')).toEqual({
      depart: { earliest: '18:00' },
      arrive: { latest: '23:00' },
    });
    expect(extractTimeWindows('arrive between 9am and 1pm')).toEqual({ arrive: { earliest: '09:00', latest: '13:00' } });
    expect(extractTimeWindows('between 6 and 10am')).toEqual({ depart: { earliest: '06:00', latest: '10:00' } });
    expect(extractTimeWindows('reaching goa in the morning')).toEqual({ arrive: { earliest: '05:00', latest: '12:00' } });
    expect(extractTimeWindows('morning flight that lands before 11am')).toEqual({
      depart: { earliest: '05:00', latest: '12:00' },
      arrive: { latest: '11:00' },
    });
  });

  it('does not read counts, dates or prices as clock times', () => {
    expect(extractTimeWindows('by 2 adults')).toEqual({});
    expect(extractTimeWindows('on the 25th')).toEqual({});
    expect(extractTimeWindows('before 5 stops')).toEqual({});
    expect(extractTimeWindows('under 20k before 9pm')).toEqual({ depart: { latest: '21:00' } });
  });
});

describe('selection', () => {
  it('reads a bare number, an ordinal and a label', () => {
    expect(extractSelection('2')).toBe(2);
    expect(extractSelection('option 3')).toBe(3);
    expect(extractSelection('the first one')).toBe(1);
    expect(extractSelection('take the second')).toBe(2);
    expect(extractSelection('the cheapest one')).toBe(1);
    expect(extractSelection('fastest please')).toBe(2);
  });

  it('does not read a selection out of a sentence that has none', () => {
    expect(extractSelection('bangalore to dubai')).toBeUndefined();
    expect(extractSelection('what about baggage')).toBeUndefined();
  });
});

describe('passenger fields', () => {
  it('pulls email, phone and passport out of a messy line', () => {
    const p = extractPassengerFields('rahul@example.com, 9876543210, passport M1234567', NOW);
    expect(p.email).toBe('rahul@example.com');
    expect(p.phone).toBe('9876543210');
    expect(p.passportNo).toBe('M1234567');
  });

  it('treats a bare two-word line as a name', () => {
    expect(extractPassengerFields('Rahul Sharma', NOW).fullName).toBe('Rahul Sharma');
    expect(extractPassengerFields('my name is priya sharma', NOW).fullName).toBe('Priya Sharma');
  });

  it('does not mistake a yes or a refinement for a name', () => {
    expect(extractPassengerFields('yes please', NOW).fullName).toBeUndefined();
    expect(extractPassengerFields('cheaper morning flight', NOW).fullName).toBeUndefined();
  });

  it('does not glue another field onto the name when several are volunteered', () => {
    // People answer "full name and date of birth?" with everything at once.
    const a = extractPassengerFields('Priya Sharma 03/11/1994 female', NOW);
    expect(a.fullName).toBe('Priya Sharma');
    expect(a.gender).toBe('F');
    expect(a.dateOfBirth).toBe('1994-11-03');

    const b = extractPassengerFields('Rahul Sharma male 9876543210 rahul@example.com', NOW);
    expect(b.fullName).toBe('Rahul Sharma');
    expect(b.phone).toBe('9876543210');

    const c = extractPassengerFields('Arjun Mehta passport M1234567 indian', NOW);
    expect(c.fullName).toBe('Arjun Mehta');
    expect(c.passportNo).toBe('M1234567');
    expect(c.nationality).toBe('Indian');
  });

  it('reads a date of birth as a past date, not a departure date', () => {
    const p = extractPassengerFields('12/04/1992', NOW);
    expect(p.dateOfBirth).toBe('1992-04-12');
  });

  it('reads gender in the forms people actually type', () => {
    expect(extractPassengerFields('male', NOW).gender).toBe('M');
    expect(extractPassengerFields('female', NOW).gender).toBe('F');
  });
});

describe('intent classification without an LLM', () => {
  const ctx = { state: 'COLLECTING_TRIP' };

  it('classifies the common turns correctly', () => {
    expect(interpretRules('hi there', ctx, NOW).intent).toBe('GREET');
    expect(interpretRules('bangalore to dubai tomorrow', ctx, NOW).intent).toBe('PROVIDE_TRIP');
    expect(interpretRules('i want to talk to a human', ctx, NOW).intent).toBe('REQUEST_HUMAN');
    expect(interpretRules('what is the baggage allowance', ctx, NOW).intent).toBe('FAQ');
    expect(interpretRules('book me a hotel in dubai', ctx, NOW).intent).toBe('OUT_OF_SCOPE');
    expect(interpretRules('start over', ctx, NOW).intent).toBe('RESTART');
  });

  it('reads a bare number as a selection only when options are on the table', () => {
    expect(interpretRules('2', { state: 'AWAITING_SELECTION', hasOffers: true }, NOW).intent).toBe('SELECT');
    expect(interpretRules('2', { state: 'COLLECTING_TRIP', hasOffers: false }, NOW).selection).toBeUndefined();
  });

  it('treats a constraint with offers already shown as a refinement', () => {
    const r = interpretRules('anything cheaper in the morning', { state: 'AWAITING_SELECTION', hasOffers: true }, NOW);
    expect(r.intent).toBe('REFINE');
    expect(r.trip.preference).toBe('CHEAPEST');
    expect(r.trip.departWindow).toEqual({ earliest: '05:00', latest: '12:00' });
  });

  it('reads an arrival deadline on its own as a refinement, not as noise', () => {
    const offers = { state: 'AWAITING_SELECTION', hasOffers: true };
    const r = interpretRules('I need to reach before noon', offers, NOW);
    expect(r.intent).toBe('REFINE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.55); // never counts towards a low-confidence handoff
    expect(r.trip.arriveWindow).toEqual({ latest: '12:00' });

    // Before any search, the same constraint is trip information to keep.
    expect(interpretRules('non-stop, landing before noon', ctx, NOW).intent).toBe('PROVIDE_TRIP');
  });

  it('understands "show all" as clearing the filters', () => {
    const r = interpretRules('show all flights', { state: 'AWAITING_SELECTION', hasOffers: true }, NOW);
    expect(r.intent).toBe('REFINE');
    expect(r.flags.clearFilters).toBe(true);
  });

  it('treats a question about a cabin as a question, not a search change', () => {
    expect(interpretRules('what is the baggage on business class?', ctx, NOW).intent).toBe('FAQ');
  });

  it('is more confident the more of the trip it recognised', () => {
    const vague = interpretRules('dubai', ctx, NOW);
    const complete = interpretRules('bangalore to dubai on 2 october, 2 adults, economy', ctx, NOW);
    expect(complete.confidence).toBeGreaterThan(vague.confidence);
  });

  it('raises the frustration and correction flags', () => {
    expect(interpretRules('this is useless', ctx, NOW).flags.frustrated).toBe(true);
    expect(interpretRules('no, i said mumbai', ctx, NOW).flags.correction).toBe(true);
    // Changing your own plan is not correcting the bot.
    expect(interpretRules('actually make it chennai instead', ctx, NOW).flags.correction).toBe(false);
  });

  it('flags a past date instead of searching it', () => {
    expect(interpretRules('fly to goa on 5 jan', ctx, NOW).flags.pastDate).toBe(false); // rolls to 2027
    const past = interpretRules('fly to goa on 2026-09-01', ctx, NOW);
    expect(past.flags.pastDate).toBe(true);
  });
});
