import { DateTime } from 'luxon';
import { getAirport } from '../flights/airports.js';
import { formatDuration, formatINR, totalDuration } from '../flights/ranking.js';
import type { FlightOffer, Itin, RankedPick } from '../flights/types.js';
import type { PassengerRecord, TripSlots } from '../db/types.js';

/**
 * Every user-visible string is built here, from tool results only.
 * WhatsApp markup: *bold*, _italic_. No buttons or list messages — they are
 * unreliable on an unofficial client, so selection is "reply 1, 2 or 3".
 */

const LABELS = {
  CHEAPEST: { emoji: '💰', text: 'Cheapest' },
  FASTEST: { emoji: '⚡', text: 'Fastest' },
  BEST_VALUE: { emoji: '⭐', text: 'Best value' },
} as const;

export function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

export function dayLabel(iso: string, tz = 'Asia/Kolkata'): string {
  return DateTime.fromISO(iso, { setZone: true }).toFormat('ccc d LLL');
}

export function stopsLabel(itin: Itin): string {
  if (itin.stops === 0) return 'non-stop';
  const via = itin.segments.slice(0, -1).map((s) => s.to).join(', ');
  return itin.stops === 1 ? `1 stop · ${via}` : `${itin.stops} stops · ${via}`;
}

/** "+1" when the flight lands the next day — the detail people miss. */
function dayOffset(itin: Itin): string {
  const dep = DateTime.fromISO(itin.segments[0].departISO, { setZone: true });
  const arr = DateTime.fromISO(itin.segments.at(-1)!.arriveISO, { setZone: true });
  const days = Math.round(arr.startOf('day').diff(dep.startOf('day'), 'days').days);
  return days > 0 ? `⁺${days}` : '';
}

export function routeLine(itin: Itin): string {
  const first = itin.segments[0];
  const last = itin.segments.at(-1)!;
  return `🛫 ${hhmm(first.departISO)} ${first.from} → 🛬 ${hhmm(last.arriveISO)}${dayOffset(itin)} ${last.to}`;
}

export function optionCard(pick: RankedPick, index: number, paxCount: number): string {
  const label = LABELS[pick.label];
  const o = pick.offer;
  const seg = o.outbound.segments[0];
  const forPax = paxCount > 1 ? ` for ${paxCount}` : '';
  const lines = [
    `*${index}.* ${label.emoji} *${label.text}* — ${formatINR(o.price.total)}${forPax}`,
    `${seg.carrierName} ${seg.flightNumber} · ${routeLine(o.outbound)}`,
    `⏱ ${formatDuration(o.outbound.totalDurationMin)} · ${stopsLabel(o.outbound)} · 🧳 ${o.baggage.checkInKg}kg`,
  ];
  if (o.inbound) {
    lines.push(`↩️ Return ${dayLabel(o.inbound.segments[0].departISO)} · ${routeLine(o.inbound)}`);
  }
  lines.push(`_${pick.whyThisOne}_`);
  return lines.join('\n');
}

export function optionsMessage(picks: RankedPick[], slots: TripSlots): string {
  const pax = (slots.adults ?? 1) + (slots.children ?? 0);
  const header = `Here are the three that matter 👇`;
  const cards = picks.map((p, i) => optionCard(p, i + 1, pax)).join('\n\n');
  // The hint deliberately carries no rupee figure: every number the bot shows
  // should be one it can point at a tool result for, and an invented example
  // budget is not one.
  const footer = `Reply *1*, *2* or *3* — or tell me what to change ("morning flights", "non-stop", "anything cheaper").`;
  return `${header}\n\n${cards}\n\n${footer}`;
}

export function searchingMessage(slots: TripSlots): string {
  const o = getAirport(slots.origin!);
  const d = getAirport(slots.destination!);
  const pax = describePax(slots);
  const cabin = (slots.cabin ?? 'ECONOMY').toLowerCase().replace('_', ' ');
  const when = dayLabel(`${slots.departDate}T00:00:00`);
  const ret = slots.returnDate ? `, back ${dayLabel(`${slots.returnDate}T00:00:00`)}` : '';
  return `Got it — *${o?.iata} → ${d?.iata}* (${o?.city} to ${d?.city}), ${when}${ret}, ${pax}, ${cabin}.\nSearching fares… ⏱`;
}

export function describePax(slots: TripSlots): string {
  const parts: string[] = [`${slots.adults ?? 1} adult${(slots.adults ?? 1) > 1 ? 's' : ''}`];
  if (slots.children) parts.push(`${slots.children} child${slots.children > 1 ? 'ren' : ''}`);
  if (slots.infants) parts.push(`${slots.infants} infant${slots.infants > 1 ? 's' : ''}`);
  return parts.join(' + ');
}

export function selectionMessage(pick: RankedPick, slots: TripSlots): string {
  const label = LABELS[pick.label];
  const o = pick.offer;
  const seg = o.outbound.segments[0];
  return (
    `${label.emoji} Locked: *${seg.flightNumber}, ${dayLabel(seg.departISO)}, ` +
    `${hhmm(seg.departISO)} ${o.outbound.segments[0].from} → ${hhmm(o.outbound.segments.at(-1)!.arriveISO)} ` +
    `${o.outbound.segments.at(-1)!.to}* · ${formatINR(o.price.total)} for ${describePax(slots)}.`
  );
}

export function itineraryCard(opts: {
  ref: string;
  offer: FlightOffer;
  passengers: PassengerRecord[];
  email: string;
  paymentLink: string;
  holdMinutes: number;
}): string {
  const { ref, offer, passengers, email, paymentLink, holdMinutes } = opts;
  const lines: string[] = [`✅ *Itinerary ${ref} confirmed*`, ''];

  lines.push(...legLines('🛫 Outbound', offer.outbound));
  if (offer.inbound) {
    lines.push('');
    lines.push(...legLines('↩️ Return', offer.inbound));
  }

  lines.push('', '👤 *Passengers*');
  for (const p of passengers) {
    lines.push(`• ${p.fullName}${p.passportNo ? ` · passport ${maskPassport(p.passportNo)}` : ''}`);
  }

  lines.push(
    '',
    '🎫 *Fare*',
    `${formatINR(offer.price.perAdult)} × ${passengers.length} = *${formatINR(offer.price.total)}*`,
    `🧳 ${offer.baggage.checkInKg}kg check-in · ${offer.baggage.cabinKg}kg cabin`,
    '',
    `📧 Sent to ${email} with your payment link.`,
    `${paymentLink}`,
    '',
    `⚠️ *Not ticketed until payment.* This quote is held for ${holdMinutes} minutes.`,
  );
  return lines.join('\n');
}

function legLines(title: string, itin: Itin): string[] {
  const lines = [`${title} — ${dayLabel(itin.segments[0].departISO)}`];
  for (const s of itin.segments) {
    lines.push(
      `${s.carrierName} ${s.flightNumber} · ${hhmm(s.departISO)} ${s.from} → ${hhmm(s.arriveISO)} ${s.to} · ${formatDuration(
        s.durationMin,
      )}`,
    );
  }
  lines.push(`⏱ Total ${formatDuration(itin.totalDurationMin)} · ${stopsLabel(itin)}`);
  return lines;
}

function maskPassport(no: string): string {
  return `${no.slice(0, 2)}••••${no.slice(-2)}`;
}

export function paymentConfirmedMessage(ref: string, total: number): string {
  return (
    `✅ *Payment received — ${ref}*\n` +
    `${formatINR(total)} confirmed. Your e-ticket details are on their way to your email.\n\n` +
    `Safe travels! ✈️ Anything else I can help with?`
  );
}

export function offerSummaryLine(o: FlightOffer): string {
  const seg = o.outbound.segments[0];
  return `${seg.carrierName} ${seg.flightNumber} · ${hhmm(seg.departISO)}→${hhmm(
    o.outbound.segments.at(-1)!.arriveISO,
  )} · ${formatDuration(totalDuration(o))} · ${formatINR(o.price.total)}`;
}
