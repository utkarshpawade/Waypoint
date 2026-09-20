import { config } from '../../config.js';
import { describePax } from '../../conversation/formatter.js';
import type { EscalationReason, TripSlots } from '../../db/types.js';

export interface AgentHandoffInput {
  ticket: string;
  reason: EscalationReason;
  /** The user's own words that triggered the handoff. */
  userQuestion: string;
  trip: TripSlots;
  name?: string;
}

const BRAND = '#0f5132';
const INK = '#1b1b1b';
const MUTED = '#6c757d';
const LINE = '#e5e5e5';

/**
 * The email a handed-off user receives.
 *
 * Deliberately written as a person, not a system: no ticket-tracker chrome, no
 * "your case has been logged" boilerplate. It opens with the agent's name,
 * repeats the question back so the user knows it was actually read, and asks
 * them to reply. What makes an escalation feel handled is a human answering,
 * and this is the closest thing to that the bot can produce on its own.
 *
 * It never attempts to answer the question — that is the human's job, and
 * guessing here would undo the exact honesty that triggered the handoff.
 */

function openingLine(reason: EscalationReason): string {
  switch (reason) {
    case 'USER_REQUESTED_HUMAN':
      return 'You asked to speak to a person, so here I am.';
    case 'POLICY_SENSITIVE':
      return "You asked about something our assistant isn't allowed to guess at, so it's come to me.";
    case 'KNOWLEDGE_GAP':
      return "Our assistant didn't want to give you an answer it wasn't sure of, so it's passed this to me.";
    case 'PROVIDER_FAILURE':
      return 'Something on our side misbehaved while our assistant was helping you, so I\'ve stepped in.';
    case 'HIGH_VALUE':
      return "I review bookings of this size personally before anything is issued.";
    case 'OUT_OF_SCOPE':
      return "What you asked sits outside what our assistant handles, so it's come to me.";
    case 'NEGATIVE_SENTIMENT':
      return "It looked like our assistant was going in circles, so I've taken over.";
    default:
      return "Our assistant has passed your conversation to me.";
  }
}

function tripLine(trip: TripSlots): string | null {
  if (!trip.origin || !trip.destination) return null;
  const bits = [`${trip.origin} → ${trip.destination}`];
  if (trip.departDate) bits.push(trip.departDate);
  bits.push(describePax(trip));
  return bits.join(' · ');
}

export function agentHandoffSubject(ticket: string, trip: TripSlots): string {
  const route = trip.origin && trip.destination ? `${trip.origin} → ${trip.destination}` : 'your trip';
  return `${config.AGENT_NAME} from Waypoint — about ${route} (${ticket})`;
}

export function agentHandoffHtml(input: AgentHandoffInput): string {
  const { ticket, reason, userQuestion, trip, name } = input;
  const greeting = name ? `Hi ${escapeHtml(name.split(' ')[0])},` : 'Hi,';
  const route = tripLine(trip);

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.AGENT_NAME)} from Waypoint</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${LINE};">

  <tr><td style="background:${BRAND};padding:18px 24px;">
    <div style="color:#ffffff;font-size:16px;font-weight:700;">Waypoint ✈️</div>
    <div style="color:#c9e4d5;font-size:12px;margin-top:3px;">Customer care · ${escapeHtml(ticket)}</div>
  </td></tr>

  <tr><td style="padding:26px 24px 8px;font-size:15px;line-height:1.65;">
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      It's <strong>${escapeHtml(config.AGENT_NAME)}</strong> from Waypoint. ${escapeHtml(openingLine(reason))}
      Let me help you out from here.
    </p>
    <p style="margin:0 0 14px;">Here's what I can see you asked:</p>
  </td></tr>

  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#f8f9fa;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;">
      <tr><td style="padding:14px 16px;font-size:14px;line-height:1.6;color:${INK};">
        “${escapeHtml(userQuestion)}”
      </td></tr>
    </table>
  </td></tr>

  ${
    route
      ? `<tr><td style="padding:16px 24px 0;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:${MUTED};padding-bottom:6px;">Your trip so far</div>
    <div style="font-size:14px;">${escapeHtml(route)}</div>
  </td></tr>`
      : ''
  }

  <tr><td style="padding:20px 24px 8px;font-size:15px;line-height:1.65;">
    <p style="margin:0 0 14px;">
      I'm looking into it now and will come back to you with a proper answer rather than a guess.
      <strong>Just reply to this email</strong> and it comes straight to me — or carry on with our
      assistant on WhatsApp if you'd like to keep planning in the meantime.
    </p>
    <p style="margin:0 0 4px;">Thanks for your patience,</p>
    <p style="margin:0;font-weight:600;">${escapeHtml(config.AGENT_NAME)}</p>
    <p style="margin:2px 0 0;font-size:13px;color:${MUTED};">${escapeHtml(config.AGENT_TITLE)}</p>
  </td></tr>

  <tr><td style="padding:20px 24px 24px;font-size:12px;color:${MUTED};line-height:1.6;border-top:1px solid ${LINE};margin-top:16px;">
    Reference ${escapeHtml(ticket)} · Please keep it on any replies.<br>
    <strong>Demo notice:</strong> Waypoint is a portfolio project. Fares are simulated and no real
    booking or payment is made.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

export function agentHandoffText(input: AgentHandoffInput): string {
  const { ticket, reason, userQuestion, trip, name } = input;
  const route = tripLine(trip);
  return [
    name ? `Hi ${name.split(' ')[0]},` : 'Hi,',
    '',
    `It's ${config.AGENT_NAME} from Waypoint. ${openingLine(reason)} Let me help you out from here.`,
    '',
    "Here's what I can see you asked:",
    `  "${userQuestion}"`,
    '',
    ...(route ? [`Your trip so far: ${route}`, ''] : []),
    'I\'m looking into it now and will come back to you with a proper answer rather than a guess.',
    'Just reply to this email and it comes straight to me — or carry on with our assistant on',
    'WhatsApp if you\'d like to keep planning in the meantime.',
    '',
    'Thanks for your patience,',
    config.AGENT_NAME,
    config.AGENT_TITLE,
    '',
    `Reference ${ticket} — please keep it on any replies.`,
    'Demo notice: Waypoint is a portfolio project. Fares are simulated and no real booking or payment is made.',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
