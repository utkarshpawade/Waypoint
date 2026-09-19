import { llm } from '../llm/client.js';
import { logger } from '../logger.js';
import { describePax } from '../conversation/formatter.js';
import { offerSummaryLine } from '../conversation/formatter.js';
import type { EscalationReason, HandoffBrief, MessageRecord, SessionRecord } from '../db/types.js';

const log = logger.child({ mod: 'brief' });

/**
 * The handoff brief. One LLM call for the summary and the suggested reply —
 * and a template fallback that produces a usable brief without it, because
 * escalation must never depend on the model working. That is the whole point
 * of escalating in the first place.
 */
export async function buildBrief(opts: {
  session: SessionRecord;
  reason: EscalationReason;
  detail?: string;
  history: MessageRecord[];
  confidenceTrace: number[];
  botTried: string[];
}): Promise<HandoffBrief> {
  const template = templateBrief(opts);
  if (!llm.available()) return template;

  try {
    const transcript = opts.history
      .slice(-10)
      .map((m) => `${m.author}: ${m.body}`)
      .join('\n');

    const raw = await llm.chatJson<{ situation?: string; blocker?: string; suggestedReply?: string }>(
      [
        {
          role: 'system',
          content: `You are writing a handoff brief for a human travel agent taking over a WhatsApp conversation.
Be factual and specific. Do not invent fares, flight numbers or policies.
Return JSON: {"situation": "<=50 words, what is happening and why the bot stopped",
"blocker": "one sentence naming exactly what the bot could not do",
"suggestedReply": "a first reply the agent could send, <=45 words, no invented facts"}`,
        },
        {
          role: 'user',
          content: `Escalation reason: ${opts.reason}${opts.detail ? ` (${opts.detail})` : ''}
Trip so far: ${tripLine(opts.session)}
Recent transcript:
${transcript}`,
        },
      ],
      400,
    );

    if (raw?.situation) {
      return {
        ...template,
        situation: String(raw.situation).slice(0, 500),
        blocker: raw.blocker ? String(raw.blocker).slice(0, 300) : template.blocker,
        suggestedReply: raw.suggestedReply ? String(raw.suggestedReply).slice(0, 400) : template.suggestedReply,
      };
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'brief generation fell back to template');
  }
  return template;
}

function tripLine(session: SessionRecord): string {
  const t = session.slots.trip;
  if (!t.origin && !t.destination) return 'nothing captured yet';
  const parts = [
    t.origin && t.destination ? `${t.origin}→${t.destination}` : (t.origin ?? t.destination ?? ''),
    t.departDate,
    t.returnDate ? `return ${t.returnDate}` : '',
    describePax(t),
    t.cabin,
  ].filter(Boolean);
  return parts.join(' · ');
}

const REASON_BLOCKERS: Record<EscalationReason, string> = {
  USER_REQUESTED_HUMAN: 'The user explicitly asked to speak to a person.',
  LOW_CONFIDENCE_REPEATED: 'Two consecutive messages the bot could not interpret confidently.',
  OUT_OF_SCOPE: 'The request is outside flight search and booking.',
  KNOWLEDGE_GAP: 'An adjacent question with no knowledge-base entry — the bot refused to guess.',
  PROVIDER_FAILURE: 'A search, model or email call failed after its retries.',
  POLICY_SENSITIVE: 'A policy-sensitive topic (refunds, medical, minors, visas, groups) that needs a human.',
  NEGATIVE_SENTIMENT: 'The user is frustrated or has corrected the bot repeatedly.',
  HIGH_VALUE: 'The quote is above the value threshold for automated issue.',
};

export function templateBrief(opts: {
  session: SessionRecord;
  reason: EscalationReason;
  detail?: string;
  history: MessageRecord[];
  confidenceTrace: number[];
  botTried: string[];
}): HandoffBrief {
  const { session, reason, detail, history } = opts;
  const lastUser = [...history].reverse().find((m) => m.author === 'USER');

  return {
    situation:
      `${reason.replace(/_/g, ' ').toLowerCase()}${detail ? ` — ${detail}` : ''}. ` +
      `Conversation was in ${session.state}. Trip: ${tripLine(session)}.` +
      (lastUser ? ` Last message: "${truncate(lastUser.body, 140)}"` : ''),
    entities: {
      state: session.state,
      trip: session.slots.trip,
      passengersCaptured: session.slots.passengers.length,
      selectedOffer: session.offers?.find((o) => o.id === session.selectedOfferId)
        ? offerSummaryLine(session.offers.find((o) => o.id === session.selectedOfferId)!)
        : null,
      bookingRef: session.slots.bookingRef ?? null,
    },
    transcript: history.slice(-10).map((m) => ({ author: m.author, body: truncate(m.body, 300) })),
    botTried: opts.botTried,
    blocker: REASON_BLOCKERS[reason] ?? 'Unknown blocker.',
    confidenceTrace: opts.confidenceTrace.slice(-5),
    suggestedReply: suggestedFor(reason, session),
  };
}

function suggestedFor(reason: EscalationReason, session: SessionRecord): string {
  const t = session.slots.trip;
  const route = t.origin && t.destination ? `${t.origin}→${t.destination}` : 'your trip';
  switch (reason) {
    case 'USER_REQUESTED_HUMAN':
      return `Hi, this is a Waypoint specialist — I've got your conversation in front of me. How can I help with ${route}?`;
    case 'POLICY_SENSITIVE':
      return `Hi, specialist here. I can confirm the exact rules for your case — give me a minute to check and I'll come back with the specifics.`;
    case 'KNOWLEDGE_GAP':
      return `Hi, specialist here. Good question — let me confirm that properly rather than guess, and I'll reply shortly.`;
    case 'PROVIDER_FAILURE':
      return `Hi, specialist here. Our search hiccuped — I'll pull the fares for ${route} manually and send them across.`;
    case 'HIGH_VALUE':
      return `Hi, specialist here. I'm reviewing this booking personally before we issue it — one moment.`;
    case 'NEGATIVE_SENTIMENT':
      return `Hi, a human here now. Sorry that was frustrating — tell me in your own words what you need and I'll sort it.`;
    default:
      return `Hi, this is a Waypoint specialist. I've read the conversation so far — how can I help?`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
