import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logger, maskId } from '../logger.js';
import { sendTo } from '../channels/registry.js';
import { describePax } from '../conversation/formatter.js';
import { buildBrief } from './brief.js';
import { isWithinBusinessHours } from './policy.js';
import { recordGap } from './gaps.js';
import { pushConsoleEvent } from '../web/sse.js';
import { sendMail } from '../email/service.js';
import {
  agentHandoffHtml,
  agentHandoffSubject,
  agentHandoffText,
} from '../email/templates/agent-handoff.html.js';
import type { EscalationReason, EscalationRecord, SessionRecord } from '../db/types.js';

const log = logger.child({ mod: 'escalation' });

export function ownerJid(): string | null {
  if (!config.OWNER_WHATSAPP) return null;
  const digits = config.OWNER_WHATSAPP.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

export async function generateTicket(): Promise<string> {
  const store = getStore();
  for (let i = 0; i < 6; i++) {
    const t = `WP-${randomBytes(2).toString('hex').toUpperCase()}`;
    if (!(await store.getEscalation(t))) return t;
  }
  return `WP-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

/** The email we already hold for this person, if any. */
export function knownEmail(session: SessionRecord): string | null {
  return (
    session.slots.passengers.find((p) => p.email)?.email ??
    session.slots.draftPassenger.email ??
    null
  );
}

/**
 * The honest handoff line the user sees. Three lines, one apology, no SLA we
 * cannot hit: outside business hours it states the actual next-available time
 * instead of promising ten minutes.
 *
 * When we have an email, the handoff is concrete — a named person has already
 * written to them, and they can see where. When we don't, asking for one is
 * the single most useful thing the bot can do next.
 */
export function userHandoffMessage(
  ticket: string,
  reason: EscalationReason,
  opts: { emailedTo?: string | null; askForEmail?: boolean } = {},
): string {
  const now = new Date();
  const open = isWithinBusinessHours(now, config.businessHours, config.BUSINESS_TZ);
  const lead =
    reason === 'USER_REQUESTED_HUMAN'
      ? '👤 Of course — putting you through to our customer care team.'
      : "⚠️ I've hit something I shouldn't guess at.";

  if (opts.emailedTo) {
    return (
      `${lead}\n` +
      `Ticket *${ticket}* — *${config.AGENT_NAME}* from our customer care team has picked this up ` +
      `and just emailed you at ${opts.emailedTo}. You can reply straight to that email.\n` +
      `I can carry on with your trip here in the meantime — want me to?`
    );
  }

  if (opts.askForEmail) {
    return (
      `${lead}\n` +
      `Ticket *${ticket}* — our customer care team will take this from here.\n` +
      `What's the best email for *${config.AGENT_NAME}* to reach you on?`
    );
  }

  if (open) {
    return (
      `${lead}\n` +
      `Ticket *${ticket}* — our customer care team will contact you within ~${config.ESCALATION_SLA_MINUTES} minutes.\n` +
      `Meanwhile I can keep noting your trip details so they don't ask twice — want me to?`
    );
  }

  const nextOpen = nextOpeningTime();
  return (
    `${lead}\n` +
    `Ticket *${ticket}*. We're outside our hours (${config.BUSINESS_HOURS} ${shortZone()}), so our customer care team will contact you by *${nextOpen}*.\n` +
    `I've logged everything so nobody asks you twice. I can keep searching flights in the meantime — want me to?`
  );
}

/**
 * Send the handoff email as the agent. Returns the address on success.
 * Never claims to have sent one that failed — the caller's wording depends on it.
 */
export async function sendAgentHandoffEmail(opts: {
  session: SessionRecord;
  ticket: string;
  reason: EscalationReason;
  to: string;
  userQuestion: string;
}): Promise<string | null> {
  const { session, ticket, reason, to, userQuestion } = opts;
  const input = {
    ticket,
    reason,
    userQuestion: userQuestion.slice(0, 300) || 'your message to our assistant',
    trip: session.slots.trip,
    name: session.displayName ?? session.slots.passengers[0]?.fullName ?? undefined,
  };

  const result = await sendMail({
    to,
    subject: agentHandoffSubject(ticket, session.slots.trip),
    html: agentHandoffHtml(input),
    text: agentHandoffText(input),
  });

  await getStore().insertEvent({
    sessionId: session.id,
    type: result.ok ? 'agent_handoff_emailed' : 'agent_handoff_email_failed',
    payload: { ticket, error: result.ok ? null : (result.error ?? 'unknown') },
  });

  if (!result.ok) {
    log.error({ ticket, err: result.error }, 'agent handoff email failed');
    return null;
  }
  log.info({ ticket }, 'agent handoff email sent');
  return to;
}

function shortZone(): string {
  return config.BUSINESS_TZ.split('/').pop()?.replace('_', ' ') ?? config.BUSINESS_TZ;
}

function nextOpeningTime(): string {
  const now = DateTime.now().setZone(config.BUSINESS_TZ);
  const [h, m] = config.businessHours.open.split(':').map(Number);
  let next = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (next <= now) next = next.plus({ days: 1 });
  const sameDay = next.hasSame(now, 'day');
  return `${sameDay ? '' : 'tomorrow '}${next.toFormat('HH:mm')}`;
}

/** The alert that lands on the owner's own phone, with the commands inline. */
export function ownerAlert(escalation: EscalationRecord, session: SessionRecord): string {
  const b = escalation.brief;
  const t = session.slots.trip;
  const waiting = Math.max(0, Math.round((Date.now() - escalation.createdAt.getTime()) / 60000));
  const who = `${maskId(session.channelUserId.split('@')[0])}${session.displayName ? ` (${session.displayName})` : ''}`;
  const lastUser = [...b.transcript].reverse().find((m) => m.author === 'USER')?.body ?? '—';

  const tripLine =
    t.origin && t.destination
      ? `${t.origin}→${t.destination}${t.departDate ? ` · ${t.departDate}` : ''} · ${describePax(t)}${
          t.cabin ? ` · ${t.cabin.toLowerCase().replace('_', ' ')}` : ''
        }`
      : 'not captured yet';

  return [
    `🔔 *Escalation ${escalation.ticket}* · reason: ${escalation.reason}`,
    `From: ${who} · waiting ${waiting}m`,
    '',
    `*Situation:* ${b.situation}`,
    `*Trip:* ${tripLine}`,
    `*Blocker:* ${b.blocker}`,
    `*Last msg:* "${b.transcript.at(-1)?.body ?? lastUser}"`,
    '',
    `*Suggested reply:* ${b.suggestedReply}`,
    '',
    `↳ /take ${escalation.ticket}`,
    `↳ /reply ${escalation.ticket} <text>`,
    `↳ /bot ${escalation.ticket}`,
    `↳ /tickets`,
  ].join('\n');
}

export interface EscalateResult {
  escalation: EscalationRecord;
  userMessage: string;
  ownerNotified: boolean;
}

/**
 * Fire an escalation: ticket, mute the bot, tell the user the truth once, and
 * push the brief to the on-call human's own WhatsApp. No dashboard required —
 * that is the entire design argument (PLAN §11.4).
 */
export async function escalate(opts: {
  session: SessionRecord;
  reason: EscalationReason;
  detail?: string;
  botTried?: string[];
  /** The user's own words that triggered this, quoted back in the email. */
  userQuestion?: string;
}): Promise<EscalateResult> {
  const store = getStore();
  const { session, reason, detail } = opts;

  const existing = await store.findOpenEscalationBySession(session.id);
  if (existing) {
    log.info({ ticket: existing.ticket }, 'escalation already open for session');
    return { escalation: existing, userMessage: '', ownerNotified: false };
  }

  const ticket = await generateTicket();
  const history = await store.recentMessages(session.id, 12);
  const confidenceTrace = history
    .filter((m) => m.author === 'USER' && typeof m.confidence === 'number')
    .map((m) => m.confidence as number);

  const brief = await buildBrief({
    session,
    reason,
    detail,
    history,
    confidenceTrace,
    botTried: opts.botTried ?? defaultBotTried(session),
  });

  const escalation = await store.createEscalation({
    ticket,
    sessionId: session.id,
    reason,
    confidence: confidenceTrace.at(-1) ?? null,
    brief,
    status: 'OPEN',
    claimedBy: null,
    resolution: null,
    slaNotifiedAt: null,
  });

  session.state = 'ESCALATED';
  session.control = 'HUMAN';
  session.slots.escalationTicket = ticket;
  await store.saveSession(session);

  await store.insertEvent({
    sessionId: session.id,
    type: 'escalation_opened',
    payload: { ticket, reason, detail: detail ?? null, state: session.state },
  });
  await recordGap(session, reason, history.at(-1)?.body ?? '');

  const owner = ownerJid();
  let ownerNotified = false;
  if (owner) {
    ownerNotified = await sendTo(owner, ownerAlert(escalation, session));
  } else {
    log.warn('OWNER_WHATSAPP not set — escalation alert not delivered');
  }

  // Reach the user as a named human, not just a ticket number. If we already
  // hold an email, write to them now; if not, the handoff message asks for one
  // and the engine sends it as soon as they answer.
  const lastUserMessage = opts.userQuestion ?? [...history].reverse().find((m) => m.author === 'USER')?.body ?? '';
  const email = knownEmail(session);
  let emailedTo: string | null = null;

  if (email) {
    emailedTo = await sendAgentHandoffEmail({
      session,
      ticket,
      reason,
      to: email,
      userQuestion: lastUserMessage,
    });
  } else {
    session.slots.pendingHandoffEmail = { ticket, reason, userQuestion: lastUserMessage.slice(0, 300) };
    await store.saveSession(session);
  }

  pushConsoleEvent('ticket', { ticket, reason, status: 'OPEN' });
  log.info({ ticket, reason, ownerNotified, emailed: Boolean(emailedTo) }, 'escalation opened');
  return {
    escalation,
    userMessage: userHandoffMessage(ticket, reason, { emailedTo, askForEmail: !email }),
    ownerNotified,
  };
}

function defaultBotTried(session: SessionRecord): string[] {
  const tried: string[] = [];
  if (session.offers?.length) tried.push(`searched and returned ${session.offers.length} offers`);
  if (session.selectedOfferId) tried.push('user had selected an option');
  if (session.slots.passengers.length) tried.push(`collected ${session.slots.passengers.length} passenger(s)`);
  if (!tried.length) tried.push('asked for the trip details');
  return tried;
}

export async function claimEscalation(ticket: string, agent: string): Promise<EscalationRecord | null> {
  const store = getStore();
  const esc = await store.getEscalation(ticket);
  if (!esc) return null;
  await store.updateEscalation(ticket, { status: 'CLAIMED', claimedBy: agent, claimedAt: new Date() });
  const session = await store.getSession(esc.sessionId);
  if (session) {
    session.state = 'HUMAN_CONTROL';
    session.control = 'HUMAN';
    await store.saveSession(session);
  }
  await store.insertEvent({ sessionId: esc.sessionId, type: 'escalation_claimed', payload: { ticket, agent } });
  return { ...esc, status: 'CLAIMED', claimedBy: agent, claimedAt: new Date() };
}

/** The furthest-along state the bot can safely pick up from. */
export function resumeStateFor(session: SessionRecord): SessionRecord['state'] {
  if (session.offers?.length) return session.selectedOfferId ? 'COLLECTING_PASSENGER' : 'AWAITING_SELECTION';
  if (session.slots.trip.origin && session.slots.trip.destination) return 'COLLECTING_TRIP';
  return 'GREETING';
}

export async function resolveEscalation(
  ticket: string,
  resolution: string,
): Promise<{ escalation: EscalationRecord; session: SessionRecord } | null> {
  const store = getStore();
  const esc = await store.getEscalation(ticket);
  if (!esc) return null;
  await store.updateEscalation(ticket, { status: 'RESOLVED', resolution, resolvedAt: new Date() });
  const session = await store.getSession(esc.sessionId);
  if (!session) return null;

  // Hand back to the bot in a state it can actually continue from.
  session.control = 'BOT';
  session.state = resumeStateFor(session);
  session.slots.escalationTicket = undefined;
  session.slots.lowConfidenceStreak = 0;
  await store.saveSession(session);

  await store.insertEvent({
    sessionId: esc.sessionId,
    type: 'escalation_resolved',
    payload: { ticket, resolution, resumedState: session.state },
  });
  return { escalation: { ...esc, status: 'RESOLVED', resolution }, session };
}

/**
 * Auto-recovery for when nobody is awake. After the SLA elapses with no claim,
 * the bot goes back to the user — honest about the delay, still useful, and
 * offering to continue the parts it can do safely.
 */
export async function runSlaSweep(now = Date.now()): Promise<number> {
  const store = getStore();
  const open = await store.listEscalations('OPEN');
  const slaMs = config.ESCALATION_SLA_MINUTES * 60_000;
  let notified = 0;

  for (const esc of open) {
    if (esc.slaNotifiedAt) continue;
    if (now - esc.createdAt.getTime() < slaMs) continue;

    const session = await store.getSession(esc.sessionId);
    if (!session) continue;

    const nextOpen = nextOpeningTime();
    const canResume = Boolean(session.slots.trip.origin && session.slots.trip.destination);
    const message =
      `Our specialist is still tied up — I don't want to leave you waiting without an update.\n` +
      `Your ticket *${esc.ticket}* is logged and they'll reply here by *${nextOpen}*.\n` +
      (canResume
        ? `Meanwhile I can still search and compare flights for you — want me to keep going?`
        : `Meanwhile I can start finding flights if you tell me where from and where to.`);

    await sendTo(session.channelUserId, message);
    await store.updateEscalation(esc.ticket, { slaNotifiedAt: new Date(now) });
    await store.insertEvent({
      sessionId: session.id,
      type: 'escalation_sla_breached',
      payload: { ticket: esc.ticket, waitedMinutes: Math.round((now - esc.createdAt.getTime()) / 60000) },
    });

    // The bot can keep doing safe work while the ticket stays open.
    session.control = 'BOT';
    session.state = session.offers?.length ? 'AWAITING_SELECTION' : 'COLLECTING_TRIP';
    await store.saveSession(session);

    const owner = ownerJid();
    if (owner) {
      await sendTo(
        owner,
        `⏰ *${esc.ticket}* has been waiting ${config.ESCALATION_SLA_MINUTES}m with no reply. ` +
          `I've told the user and resumed safe self-service. /take ${esc.ticket} when you can.`,
      );
    }
    notified++;
  }
  return notified;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startSlaSweeper(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runSlaSweep().catch((err) => log.error({ err }, 'sla sweep failed'));
  }, intervalMs);
  sweepTimer.unref?.();
  log.info({ intervalMs }, 'sla sweeper started');
}

export function stopSlaSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
