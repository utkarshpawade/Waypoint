import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  describePax,
  hhmm,
  itineraryCard,
  optionCard,
  optionsMessage,
  routeLine,
  stopsLabel,
} from '../src/conversation/formatter.js';
import { splitMessage } from '../src/channels/baileys.js';
import { topThree } from '../src/flights/ranking.js';
import { generateOffers } from '../src/flights/mock.js';
import type { FlightOffer, RankedPick } from '../src/flights/types.js';
import type { PassengerRecord } from '../src/db/types.js';

const OFFERS = generateOffers({
  origin: 'BLR',
  destination: 'DXB',
  departDate: '2026-12-15',
  adults: 2,
  cabin: 'ECONOMY',
  currency: 'INR',
});

const PICKS: RankedPick[] = topThree(OFFERS);

const PASSENGERS: PassengerRecord[] = [
  {
    bookingRef: 'WP-TEST01',
    seq: 1,
    fullName: 'Rahul Sharma',
    dob: '1992-04-12',
    gender: 'M',
    email: 'rahul@example.com',
    phone: '9876543210',
    passportNo: 'M1234567',
    passportExpiry: '2031-08-20',
    nationality: 'Indian',
  },
];

describe('time and route formatting', () => {
  it('shows local times, not UTC', () => {
    expect(hhmm('2026-12-15T06:50:00+05:30')).toBe('06:50');
    expect(hhmm('2026-12-15T23:05:00+04:00')).toBe('23:05');
  });

  it('keeps the airport’s own date rather than the server’s', () => {
    expect(dayLabel('2026-12-15T23:30:00+05:30')).toBe('Tue 15 Dec');
  });

  it('marks a next-day arrival', () => {
    const overnight = {
      segments: [
        {
          carrierCode: '6E',
          carrierName: 'IndiGo',
          flightNumber: '6E-101',
          from: 'BLR',
          to: 'DXB',
          departISO: '2026-12-15T23:30:00+05:30',
          arriveISO: '2026-12-16T01:45:00+04:00',
          durationMin: 255,
        },
      ],
      totalDurationMin: 255,
      stops: 0,
      layoverMin: [],
    };
    expect(routeLine(overnight)).toMatch(/⁺1/);
    expect(routeLine(overnight)).toMatch(/23:30 BLR/);
  });

  it('names the connecting airport on a multi-stop itinerary', () => {
    const oneStop = OFFERS.find((o) => o.outbound.stops === 1);
    if (!oneStop) return;
    const label = stopsLabel(oneStop.outbound);
    expect(label).toMatch(/^1 stop · [A-Z]{3}$/);
  });

  it('describes the passenger mix in words', () => {
    expect(describePax({ adults: 1 })).toBe('1 adult');
    expect(describePax({ adults: 2, children: 1 })).toBe('2 adults + 1 child');
    expect(describePax({ adults: 2, children: 2, infants: 1 })).toBe('2 adults + 2 children + 1 infant');
  });
});

describe('option cards', () => {
  it('puts the label, fare, flight, duration and reason on one card', () => {
    const card = optionCard(PICKS[0], 1, 2);
    expect(card).toMatch(/^\*1\.\* 💰 \*Cheapest\* — ₹[\d,]+ for 2/);
    expect(card).toMatch(/🛫 \d{2}:\d{2} BLR/);
    expect(card).toMatch(/⏱ \d+h \d{2}m/);
    expect(card).toMatch(/🧳 \d+kg/);
    expect(card.split('\n').at(-1)).toMatch(/^_.+\.\_?$/); // the italic why-line
  });

  it('keeps every card within six lines, as WhatsApp needs', () => {
    for (const [i, p] of PICKS.entries()) {
      expect(optionCard(p, i + 1, 2).split('\n').length).toBeLessThanOrEqual(6);
    }
  });

  it('renders exactly three numbered options and the reply instruction', () => {
    const msg = optionsMessage(PICKS, { adults: 2 });
    expect(msg).toMatch(/\*1\.\*/);
    expect(msg).toMatch(/\*2\.\*/);
    expect(msg).toMatch(/\*3\.\*/);
    expect(msg).not.toMatch(/\*4\.\*/);
    expect(msg).toMatch(/Reply \*1\*, \*2\* or \*3\*/);
  });

  it('quotes no invented example budget in the hint', () => {
    const msg = optionsMessage(PICKS, { adults: 2 });
    const hint = msg.split('\n').at(-1)!;
    expect(hint).not.toMatch(/₹/);
  });
});

describe('itinerary card', () => {
  const card = itineraryCard({
    ref: 'WP-TEST01',
    offer: OFFERS[0],
    passengers: PASSENGERS,
    email: 'rahul@example.com',
    paymentLink: 'https://example.com/pay/WP-TEST01',
    holdMinutes: 30,
  });

  it('leads with the reference and carries the fare breakdown', () => {
    expect(card).toMatch(/^✅ \*Itinerary WP-TEST01 confirmed\*/);
    expect(card).toMatch(/🎫 \*Fare\*/);
    expect(card).toMatch(/₹[\d,]+ × 1 = \*₹[\d,]+\*/);
  });

  it('states plainly that nothing is ticketed until payment', () => {
    expect(card).toMatch(/Not ticketed until payment/);
    expect(card).toMatch(/held for 30 minutes/);
  });

  it('masks the passport number', () => {
    expect(card).toMatch(/M1••••67/);
    expect(card).not.toMatch(/M1234567/);
  });

  it('includes the payment link and the address it was sent to', () => {
    expect(card).toMatch(/https:\/\/example\.com\/pay\/WP-TEST01/);
    expect(card).toMatch(/rahul@example\.com/);
  });
});

describe('message splitting', () => {
  it('leaves a short message alone', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits on paragraph boundaries and never exceeds the cap', () => {
    const para = 'x'.repeat(300);
    const long = Array.from({ length: 20 }, () => para).join('\n\n');
    const parts = splitMessage(long, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join('\n\n')).toBe(long);
  });

  it('splits a single oversized paragraph on line breaks rather than mid-word', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
    const parts = splitMessage(lines, 500);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    expect(parts.join('\n')).toBe(lines);
  });
});
