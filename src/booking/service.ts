import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logger } from '../logger.js';
import { sendMail } from '../email/service.js';
import { itineraryHtml, itinerarySubject, itineraryText } from '../email/templates/itinerary.html.js';
import type { BookingRecord, PassengerRecord, SessionRecord } from '../db/types.js';
import type { FlightOffer } from '../flights/types.js';

const log = logger.child({ mod: 'booking' });

export const HOLD_MINUTES = 30;

/** WP- + 6 base36 characters, checked for collisions. */
export async function generateRef(): Promise<string> {
  const store = getStore();
  for (let i = 0; i < 6; i++) {
    const body = randomBytes(5)
      .toString('hex')
      .split('')
      .map((c) => parseInt(c, 16).toString(36))
      .join('')
      .slice(0, 6)
      .toUpperCase();
    const ref = `WP-${body}`;
    if (!(await store.getBooking(ref))) return ref;
  }
  return `WP-${Date.now().toString(36).slice(-6).toUpperCase()}`;
}

export function paymentLinkFor(ref: string): string {
  return `${config.publicBaseUrl}/pay/${ref}`;
}

export interface QuoteResult {
  booking: BookingRecord;
  passengers: PassengerRecord[];
  emailed: boolean;
  emailError?: string;
  emailSimulated?: boolean;
}

/**
 * Creates the quote, persists passengers, and emails the itinerary.
 * No flight is ever actually ticketed — we issue a held quote plus a payment
 * link, and every user-facing string says so.
 */
export async function createQuote(session: SessionRecord, offer: FlightOffer): Promise<QuoteResult> {
  const store = getStore();
  const ref = await generateRef();
  const paymentLink = paymentLinkFor(ref);

  const drafts = session.slots.passengers;
  const email = drafts.find((p) => p.email)?.email ?? '';

  const booking = await store.createBooking({
    ref,
    sessionId: session.id,
    offer,
    total: offer.price.total,
    currency: offer.price.currency,
    status: 'AWAITING_PAYMENT',
    paymentLink,
    emailTo: email || null,
    emailedAt: null,
    paidAt: null,
  });

  const passengers: PassengerRecord[] = drafts.map((p, i) => ({
    bookingRef: ref,
    seq: i + 1,
    fullName: p.fullName ?? '',
    dob: p.dateOfBirth ?? '',
    gender: p.gender ?? 'X',
    email: p.email ?? null,
    phone: p.phone ?? null,
    passportNo: p.passportNo ?? null,
    passportExpiry: p.passportExpiry ?? null,
    nationality: p.nationality ?? null,
  }));
  await store.insertPassengers(passengers);

  await store.insertEvent({
    sessionId: session.id,
    type: 'booking_quoted',
    payload: { ref, total: offer.price.total, carrier: offer.outbound.segments[0].carrierCode },
  });

  let emailed = false;
  let emailError: string | undefined;
  let emailSimulated = false;

  if (email) {
    const input = {
      ref,
      offer,
      passengers,
      trip: session.slots.trip,
      paymentLink,
      holdMinutes: HOLD_MINUTES,
    };
    const result = await sendMail({
      to: email,
      subject: itinerarySubject(ref, session.slots.trip, offer),
      html: itineraryHtml(input),
      text: itineraryText(input),
    });
    emailed = result.ok;
    emailError = result.error;
    emailSimulated = Boolean(result.simulated);
    if (result.ok) {
      await store.updateBooking(ref, { emailedAt: new Date() });
      await store.insertEvent({ sessionId: session.id, type: 'itinerary_emailed', payload: { ref } });
    } else {
      log.error({ ref, err: result.error }, 'itinerary email failed');
      await store.insertEvent({
        sessionId: session.id,
        type: 'itinerary_email_failed',
        payload: { ref, error: result.error ?? 'unknown' },
      });
    }
  }

  return { booking, passengers, emailed, emailError, emailSimulated };
}

export async function markPaid(ref: string): Promise<BookingRecord | null> {
  const store = getStore();
  const booking = await store.getBooking(ref);
  if (!booking) return null;
  if (booking.status === 'PAID') return booking;
  await store.updateBooking(ref, { status: 'PAID', paidAt: new Date() });
  await store.insertEvent({ sessionId: booking.sessionId, type: 'payment_simulated', payload: { ref } });
  log.info({ ref }, 'booking marked paid');
  return { ...booking, status: 'PAID', paidAt: new Date() };
}
