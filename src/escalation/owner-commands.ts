import { config } from '../config.js';
import { getStore } from '../db/index.js';
import { logger, maskId } from '../logger.js';
import { sendTo } from '../channels/registry.js';
import { claimEscalation, ownerJid, resolveEscalation } from './service.js';
import { recordResolution } from './gaps.js';

const log = logger.child({ mod: 'owner-cmd' });

/**
 * Agent control over WhatsApp.
 *
 * A handoff that depends on someone watching a dashboard does not work at 11pm.
 * So the on-call human gets the alert on the channel they already have open,
 * and can take over, reply and hand back from their phone. ~150 lines, and the
 * most product-minded thing in the repo.
 */

export const AGENT_NAME = 'Priya (Waypoint)';

export function isOwner(channelUserId: string): boolean {
  const owner = ownerJid();
  if (!owner) return false;
  return channelUserId.split(':')[0].split('@')[0] === owner.split('@')[0];
}

export function looksLikeCommand(text: string): boolean {
  return /^\s*\/(take|reply|bot|tickets|ticket|status|help|close)\b/i.test(text);
}

const HELP = [
  '*Waypoint agent commands*',
  '`/tickets` — open and claimed tickets',
  '`/ticket WP-XXXX` — full brief for one ticket',
  '`/take WP-XXXX` — take over that conversation',
  '`/reply WP-XXXX <text>` — send a message to the user as an agent',
  '`/bot WP-XXXX` — hand control back to the bot',
  '`/status` — connection, store and model status',
].join('\n');

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export async function handleOwnerCommand(text: string): Promise<CommandResult> {
  const store = getStore();
  const trimmed = text.trim();
  const [, rawCmd = '', rest = ''] = /^\s*\/(\w+)\s*([\s\S]*)$/.exec(trimmed) ?? [];
  const cmd = rawCmd.toLowerCase();

  switch (cmd) {
    case 'help':
      return { handled: true, reply: HELP };

    case 'status': {
      const { llm } = await import('../llm/client.js');
      const s = llm.status();
      const open = await store.listEscalations('OPEN');
      const claimed = await store.listEscalations('CLAIMED');
      return {
        handled: true,
        reply: [
          '*Waypoint status*',
          `store: ${store.kind}`,
          `model: ${s.configured ? s.model : 'not configured (rules only)'}${s.circuitOpen ? ' · circuit OPEN' : ''}`,
          `tickets: ${open.length} open, ${claimed.length} claimed`,
          `base url: ${config.publicBaseUrl}`,
        ].join('\n'),
      };
    }

    case 'tickets': {
      const open = await store.listEscalations('OPEN');
      const claimed = await store.listEscalations('CLAIMED');
      const all = [...open, ...claimed];
      if (!all.length) return { handled: true, reply: '✅ No open tickets.' };
      const lines = all.slice(0, 10).map((e) => {
        const mins = Math.round((Date.now() - e.createdAt.getTime()) / 60000);
        const flag = mins > config.ESCALATION_SLA_MINUTES ? '🔴' : '🟡';
        return `${flag} *${e.ticket}* · ${e.reason} · ${mins}m${e.claimedBy ? ` · claimed` : ''}`;
      });
      return { handled: true, reply: [`*${all.length} ticket(s)*`, ...lines].join('\n') };
    }

    case 'ticket': {
      const ticket = normaliseTicket(rest);
      const esc = ticket ? await store.getEscalation(ticket) : null;
      if (!esc) return { handled: true, reply: `Couldn't find ticket ${ticket ?? '(none given)'}.` };
      const b = esc.brief;
      return {
        handled: true,
        reply: [
          `*${esc.ticket}* · ${esc.reason} · ${esc.status}`,
          '',
          `*Situation:* ${b.situation}`,
          `*Blocker:* ${b.blocker}`,
          '',
          '*Transcript:*',
          ...b.transcript.slice(-6).map((m) => `${m.author === 'USER' ? '👤' : '🤖'} ${m.body}`),
          '',
          `*Suggested:* ${b.suggestedReply}`,
        ].join('\n'),
      };
    }

    case 'take': {
      const ticket = normaliseTicket(rest);
      if (!ticket) return { handled: true, reply: 'Usage: `/take WP-XXXX`' };
      const esc = await claimEscalation(ticket, AGENT_NAME);
      if (!esc) return { handled: true, reply: `Couldn't find ticket ${ticket}.` };
      const session = await store.getSession(esc.sessionId);
      if (session) {
        await sendTo(
          session.channelUserId,
          `👤 *${AGENT_NAME}* has joined the chat and is reading your conversation now.`,
        );
      }
      return {
        handled: true,
        reply: `✅ You have *${ticket}*. The bot is muted on that chat.\nSend with \`/reply ${ticket} <text>\`, hand back with \`/bot ${ticket}\`.`,
      };
    }

    case 'reply': {
      const ticket = normaliseTicket(rest);
      const body = rest.slice(rest.indexOf(' ') + 1).trim();
      if (!ticket || !body || body === rest.trim()) {
        return { handled: true, reply: 'Usage: `/reply WP-XXXX your message here`' };
      }
      const esc = await store.getEscalation(ticket);
      if (!esc) return { handled: true, reply: `Couldn't find ticket ${ticket}.` };
      const session = await store.getSession(esc.sessionId);
      if (!session) return { handled: true, reply: `Ticket ${ticket} has no session attached.` };

      // Claim implicitly — replying is taking over, and asking twice at 11pm is friction.
      if (esc.status === 'OPEN') await claimEscalation(ticket, AGENT_NAME);

      const delivered = await sendTo(session.channelUserId, `👤 *${AGENT_NAME}*:\n${body}`);
      await store.insertMessage({
        sessionId: session.id,
        direction: 'OUT',
        author: 'AGENT',
        body,
        intent: 'agent_reply',
      });
      await store.insertEvent({ sessionId: session.id, type: 'agent_reply', payload: { ticket } });
      log.info({ ticket, to: maskId(session.channelUserId) }, 'agent reply relayed');
      return {
        handled: true,
        reply: delivered ? `📤 Sent to ${maskId(session.channelUserId.split('@')[0])}.` : '⚠️ Could not deliver.',
      };
    }

    case 'bot':
    case 'close': {
      const ticket = normaliseTicket(rest);
      if (!ticket) return { handled: true, reply: 'Usage: `/bot WP-XXXX`' };
      const resolution = rest.replace(ticket, '').trim() || 'handled by agent over WhatsApp';
      const result = await resolveEscalation(ticket, resolution);
      if (!result) return { handled: true, reply: `Couldn't find ticket ${ticket}.` };
      await recordResolution(result.session.id, ticket, resolution);

      await sendTo(
        result.session.channelUserId,
        `🤖 Thanks for holding — I'm picking things up from what ${AGENT_NAME.split(' ')[0]} sorted out.\n` +
          resumeLine(result.session.state),
      );
      return { handled: true, reply: `✅ *${ticket}* resolved. Bot resumed in ${result.session.state}.` };
    }

    default:
      return { handled: false };
  }
}

function resumeLine(state: string): string {
  switch (state) {
    case 'AWAITING_SELECTION':
      return 'Your three options are still on the table — reply *1*, *2* or *3*, or tell me what to change.';
    case 'COLLECTING_PASSENGER':
      return "Shall we carry on with the traveller details? Tell me when you're ready.";
    case 'COLLECTING_TRIP':
      return 'Want me to carry on finding flights for that trip?';
    default:
      return 'What would you like to do next?';
  }
}

function normaliseTicket(rest: string): string | null {
  const m = /\b(WP-[A-Z0-9]{4,8})\b/i.exec(rest);
  return m ? m[1].toUpperCase() : null;
}
