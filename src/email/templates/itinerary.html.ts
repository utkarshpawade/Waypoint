import { formatDuration, formatINR } from '../../flights/ranking.js';
import { dayLabel, describePax, hhmm, stopsLabel } from '../../conversation/formatter.js';
import type { FlightOffer, Itin } from '../../flights/types.js';
import type { PassengerRecord, TripSlots } from '../../db/types.js';

export interface ItineraryEmailInput {
  ref: string;
  offer: FlightOffer;
  passengers: PassengerRecord[];
  trip: TripSlots;
  paymentLink: string;
  holdMinutes: number;
  supportNumber?: string;
}

const BRAND = '#0f5132';
const ACCENT = '#198754';
const INK = '#1b1b1b';
const MUTED = '#6c757d';
const LINE = '#e5e5e5';

/**
 * Table-based, inline-CSS, <=600px wide — the only HTML that survives Gmail,
 * Outlook and the iOS Mail app alike. A plain-text part ships alongside it.
 */
export function itineraryHtml(input: ItineraryEmailInput): string {
  const { ref, offer, passengers, paymentLink, holdMinutes } = input;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waypoint itinerary ${ref}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${LINE};">

  <tr><td style="background:${BRAND};padding:20px 24px;">
    <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.3px;">Waypoint ✈️</div>
    <div style="color:#c9e4d5;font-size:13px;margin-top:4px;">Itinerary ${ref}</div>
  </td></tr>

  <tr><td style="padding:24px;">
    <div style="font-size:16px;font-weight:600;margin-bottom:4px;">Your flight is held</div>
    <div style="font-size:14px;color:${MUTED};line-height:1.5;">
      Complete payment within ${holdMinutes} minutes to have the ticket issued.
      This booking is <strong>not ticketed</strong> until payment is received.
    </div>
  </td></tr>

  ${legTable('Outbound', offer.outbound)}
  ${offer.inbound ? legTable('Return', offer.inbound) : ''}

  <tr><td style="padding:0 24px 8px;">
    <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};padding-bottom:8px;">Passengers</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      ${passengers
        .map(
          (p, i) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid ${LINE};">${escapeHtml(p.fullName)}</td>
        <td align="right" style="padding:6px 0;border-bottom:1px solid ${LINE};color:${MUTED};">Passenger ${i + 1}</td>
      </tr>`,
        )
        .join('')}
    </table>
  </td></tr>

  <tr><td style="padding:20px 24px 8px;">
    <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};padding-bottom:8px;">Fare</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      <tr><td style="padding:4px 0;">${formatINR(offer.price.perAdult)} × ${passengers.length} traveller${
        passengers.length > 1 ? 's' : ''
      }</td>
        <td align="right" style="padding:4px 0;">${formatINR(offer.price.perAdult * passengers.length)}</td></tr>
      <tr><td style="padding:4px 0;color:${MUTED};">Taxes &amp; fees</td>
        <td align="right" style="padding:4px 0;color:${MUTED};">included</td></tr>
      <tr><td style="padding:10px 0 0;border-top:2px solid ${INK};font-weight:700;">Total</td>
        <td align="right" style="padding:10px 0 0;border-top:2px solid ${INK};font-weight:700;">${formatINR(
          offer.price.total,
        )}</td></tr>
    </table>
  </td></tr>

  <tr><td align="center" style="padding:24px;">
    <a href="${paymentLink}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 28px;border-radius:8px;">
      Complete payment — ${formatINR(offer.price.total)}
    </a>
    <div style="font-size:12px;color:${MUTED};margin-top:10px;">or paste this link: ${paymentLink}</div>
  </td></tr>

  <tr><td style="padding:0 24px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;">
      <tr><td style="padding:14px 16px;font-size:13px;color:${MUTED};line-height:1.6;">
        🧳 <strong>Baggage:</strong> ${offer.baggage.checkInKg}kg check-in + ${offer.baggage.cabinKg}kg cabin per traveller.<br>
        🔁 <strong>Changes:</strong> ${
          offer.refundable ? 'Refundable fare, airline charges apply.' : 'Non-refundable fare; date changes carry a fee.'
        }<br>
        🕒 <strong>Check-in:</strong> opens 48h before departure. Reach the airport 2h early (3h international).
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 24px 24px;font-size:12px;color:${MUTED};line-height:1.6;border-top:1px solid ${LINE};padding-top:16px;">
    Questions? Just reply on WhatsApp — a human will pick it up if I can't.<br>
    <strong>Demo notice:</strong> Waypoint is a portfolio project. Fares are simulated and the payment page
    does not process real money.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function legTable(title: string, itin: Itin): string {
  const first = itin.segments[0];
  const last = itin.segments.at(-1)!;
  return `<tr><td style="padding:8px 24px 16px;">
    <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};padding-bottom:8px;">${title} · ${dayLabel(
      first.departISO,
    )}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:8px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:22px;font-weight:700;">${hhmm(first.departISO)}</td>
            <td align="center" style="font-size:12px;color:${MUTED};">${formatDuration(itin.totalDurationMin)}<br>${stopsLabel(
              itin,
            )}</td>
            <td align="right" style="font-size:22px;font-weight:700;">${hhmm(last.arriveISO)}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:${MUTED};">${first.from}</td>
            <td></td>
            <td align="right" style="font-size:13px;color:${MUTED};">${last.to}</td>
          </tr>
        </table>
      </td></tr>
      ${itin.segments
        .map(
          (s) => `<tr><td style="padding:10px 16px;border-top:1px solid ${LINE};font-size:13px;color:${INK};">
        <strong>${escapeHtml(s.carrierName)} ${s.flightNumber}</strong> · ${hhmm(s.departISO)} ${s.from} → ${hhmm(
          s.arriveISO,
        )} ${s.to} · ${formatDuration(s.durationMin)}
      </td></tr>`,
        )
        .join('')}
    </table>
  </td></tr>`;
}

export function itineraryText(input: ItineraryEmailInput): string {
  const { ref, offer, passengers, paymentLink, holdMinutes } = input;
  const lines = [
    `WAYPOINT — ITINERARY ${ref}`,
    '',
    `Your flight is held. Complete payment within ${holdMinutes} minutes to have the ticket issued.`,
    'This booking is NOT ticketed until payment is received.',
    '',
  ];
  const leg = (title: string, itin: Itin) => {
    lines.push(`${title.toUpperCase()} — ${dayLabel(itin.segments[0].departISO)}`);
    for (const s of itin.segments) {
      lines.push(
        `  ${s.carrierName} ${s.flightNumber}  ${hhmm(s.departISO)} ${s.from} -> ${hhmm(s.arriveISO)} ${s.to}  (${formatDuration(
          s.durationMin,
        )})`,
      );
    }
    lines.push(`  Total ${formatDuration(itin.totalDurationMin)} · ${stopsLabel(itin)}`, '');
  };
  leg('Outbound', offer.outbound);
  if (offer.inbound) leg('Return', offer.inbound);

  lines.push(
    'PASSENGERS',
    ...passengers.map((p, i) => `  ${i + 1}. ${p.fullName}`),
    '',
    'FARE',
    `  ${formatINR(offer.price.perAdult)} x ${passengers.length} = ${formatINR(offer.price.total)}`,
    `  Baggage: ${offer.baggage.checkInKg}kg check-in + ${offer.baggage.cabinKg}kg cabin`,
    '',
    `COMPLETE PAYMENT: ${paymentLink}`,
    '',
    'Questions? Reply on WhatsApp.',
    'Demo notice: Waypoint is a portfolio project. Fares are simulated and the payment page does not process real money.',
  );
  return lines.join('\n');
}

export function itinerarySubject(ref: string, trip: TripSlots, offer: FlightOffer): string {
  const first = offer.outbound.segments[0];
  const last = offer.outbound.segments.at(-1)!;
  return `Your Waypoint itinerary ${ref} — ${first.from} → ${last.to}, ${dayLabel(first.departISO)}`;
}

export function paidSubject(ref: string): string {
  return `Payment confirmed — Waypoint itinerary ${ref}`;
}

export { describePax };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
