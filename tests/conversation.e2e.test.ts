import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryChannel } from '../src/channels/memory.js';
import { setActiveChannel } from '../src/channels/registry.js';
import { MemoryStore } from '../src/db/memory-store.js';
import { getStore, setStore } from '../src/db/index.js';
import { handleTurn, verifyOutbound } from '../src/conversation/engine.js';
import { handleOwnerCommand } from '../src/escalation/owner-commands.js';
import { runSlaSweep } from '../src/escalation/service.js';
import { markPaid } from '../src/booking/service.js';
import type { InboundMessage } from '../src/channels/types.js';

/**
 * End-to-end through the real engine, the real ranking and the real mock
 * inventory — only the channel and the store are doubles. No LLM key is set in
 * tests, so this also proves the rules engine alone can drive the whole flow.
 */

const DEPART = DateTime.now().setZone('Asia/Kolkata').plus({ days: 21 }).toFormat('d LLLL');

let channel: MemoryChannel;
let seq = 0;

function makeChannel() {
  setStore(new MemoryStore());
  channel = new MemoryChannel();
  setActiveChannel(channel);
  channel.onMessage((m) => handleTurn(m, channel));
}

async function say(text: string, user = 'e2e-user'): Promise<string> {
  const before = channel.sent.length;
  await channel.userSays(text, user);
  return channel.transcriptSince(before);
}

beforeEach(() => {
  makeChannel();
  seq = 0;
});

describe('happy path', () => {
  it('greets, searches, ranks, collects and quotes — with no LLM configured', async () => {
    const greeting = await say('hey need flights');
    expect(greeting).toMatch(/Waypoint/);
    expect(greeting).toMatch(/Where from/i);

    const options = await say(`bangalore to dubai on ${DEPART}, 2 adults`);
    expect(options).toMatch(/BLR → DXB/);
    expect(options).toMatch(/Cheapest/);
    expect(options).toMatch(/Fastest/);
    expect(options).toMatch(/Best value/);
    expect(options).toMatch(/Reply \*1\*, \*2\* or \*3\*/);
    // Three options, each with an explanation line.
    expect(options.match(/₹[\d,]+ for 2/g)?.length).toBe(3);

    const locked = await say('3');
    expect(locked).toMatch(/Locked/);
    expect(locked).toMatch(/full name/i);

    await say('Rahul Sharma');
    await say('12/04/1992 male');
    await say('rahul@example.com 9876543210');
    const secondPax = await say('M1234567 expires 20/08/2031 indian');
    expect(secondPax).toMatch(/Passenger 1 saved/);
    expect(secondPax).toMatch(/Passenger 2 of 2/);

    await say('Priya Sharma');
    await say('03/11/1994 female');
    await say('priya@example.com 9876501234');
    const confirm = await say('K7654321 expiry 12/12/2030 indian');
    expect(confirm).toMatch(/Ready to issue/);
    expect(confirm).toMatch(/Rahul Sharma, Priya Sharma/);

    const itinerary = await say('yes');
    expect(itinerary).toMatch(/Itinerary WP-[A-Z0-9]{6} confirmed/);
    expect(itinerary).toMatch(/Not ticketed until payment/);
    expect(itinerary).toMatch(/\/pay\/WP-/);

    const bookings = await getStore().listEscalations();
    // Email is not configured in tests, so an honest PROVIDER_FAILURE ticket
    // is the correct outcome — the bot must not claim it sent one.
    expect(itinerary).toMatch(/couldn't get the email through/);
    expect(bookings.some((e) => e.reason === 'PROVIDER_FAILURE')).toBe(true);
  });

  it('never states a fare that is not a real one, or a real difference between two', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    const fares = (session!.offers ?? []).flatMap((o) => [o.price.total, o.price.perAdult]);
    const deltas = fares.flatMap((a) => fares.map((b) => Math.abs(a - b)));
    const shown = channel.sent.map((s) => s.text).join('\n');

    const amounts = shown.match(/₹[\d,]+/g) ?? [];
    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) {
      const value = Number(amount.replace(/[₹,]/g, ''));
      expect(fares.includes(value) || deltas.includes(value), `${amount} is not a fare or a fare delta`).toBe(true);
    }
  });

  it('never states a flight number that was not offered', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    const offered = new Set(
      (session!.offers ?? []).flatMap((o) => o.outbound.segments.map((s) => s.flightNumber)),
    );
    const shown = channel.sent.map((s) => s.text).join('\n');
    for (const fn of shown.match(/\b[A-Z0-9]{2}-\d{2,4}\b/g) ?? []) {
      expect(offered.has(fn), `${fn} was never offered`).toBe(true);
    }
  });
});

describe('refinement', () => {
  it('re-ranks the cached offers without hitting the provider again', async () => {
    await say('hi');
    await say(`mumbai to singapore on ${DEPART}`);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    const cached = session!.offers!.map((o) => o.id);

    const refined = await say('non-stop only please');
    expect(refined).toMatch(/Re-ranking/);
    expect(refined).toMatch(/non-stop only/);

    const after = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(after!.offers!.map((o) => o.id)).toEqual(cached); // same cache, no new search
  });

  it('says so honestly when a budget cannot be met, and shows the closest fare', async () => {
    await say('hi');
    await say(`delhi to dubai on ${DEPART}`);
    const tight = await say('under 5000');
    expect(tight).toMatch(/Nothing under ₹5,000/);
    expect(tight).toMatch(/closest I have is ₹/);
  });

  it('runs a fresh search when the route changes', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    const changed = await say(`actually make it chennai to goa on ${DEPART}`);
    expect(changed).toMatch(/MAA → GOI/);
  });
});

describe('disambiguation and bad dates', () => {
  it('asks which airport when a city has several', async () => {
    await say('hi');
    const asked = await say('delhi to london next month');
    expect(asked).toMatch(/more than one airport/);
    expect(asked).toMatch(/LHR/);
    expect(asked).toMatch(/LGW/);

    const resolved = await say('LHR');
    expect(resolved).toMatch(/DEL → LHR/);
  });

  it('corrects a date that has already passed instead of searching it', async () => {
    await say('hi');
    const flagged = await say('bangalore to dubai on 2020-01-05');
    expect(flagged).toMatch(/has already gone by/);
    expect(flagged).toMatch(/2021/);
  });
});

describe('escalation', () => {
  it('hands off when the user asks for a human, and stops replying', async () => {
    await say('hi');
    const handoff = await say('I want to talk to a human');
    expect(handoff).toMatch(/Ticket \*WP-[A-Z0-9]{4}\*/);
    expect(handoff).toMatch(/customer care/i);

    const tickets = await getStore().listEscalations('OPEN');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].reason).toBe('USER_REQUESTED_HUMAN');
    expect(tickets[0].brief.suggestedReply.length).toBeGreaterThan(10);

    // The bot is muted: the next user message is relayed, not answered.
    const silent = await say('are you there?');
    expect(silent).toBe('');
  });

  it('asks for an email so a named agent can reach them, when it has none', async () => {
    await say('hi');
    const handoff = await say('I want to talk to a human');
    expect(handoff).toMatch(/customer care/i);
    expect(handoff).toMatch(/Utkarsh/);
    expect(handoff).toMatch(/best email/i);

    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.pendingHandoffEmail?.reason).toBe('USER_REQUESTED_HUMAN');
  });

  it('sends the agent email once an address is given, and resumes helping', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('I want to talk to a human');
    const confirmed = await say('sure, rahul@example.com');

    // SMTP is unconfigured in tests, so the bot must NOT claim it sent one.
    expect(confirmed).toMatch(/couldn't get an email through to rahul@example\.com/);
    expect(confirmed).toMatch(/still open/);

    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.pendingHandoffEmail).toBeUndefined();
    expect(session!.control).toBe('BOT'); // it can keep helping while the ticket stays open
    expect(session!.slots.draftPassenger.email).toBe('rahul@example.com');
    expect(await getStore().listEscalations('OPEN')).toHaveLength(1);
  });

  it('does not nag when the user declines to give an email', async () => {
    await say('hi');
    await say('get me an agent');
    const declined = await say('no thanks');
    expect(declined).toMatch(/kept ticket/i);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.pendingHandoffEmail).toBeUndefined();
    expect(session!.control).toBe('BOT');
  });

  it('emails the agent handoff straight away when it already has the address', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('1');
    await say('Rahul Sharma');
    await say('12/04/1992 male');
    await say('rahul@example.com 9876543210');
    // The address is on file now, so an escalation should not ask for it again.
    const handoff = await say('actually can i get a refund on this');
    expect(handoff).toMatch(/Ticket \*WP-/);
    expect(handoff).not.toMatch(/best email/i);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.pendingHandoffEmail).toBeUndefined();
  });

  it('refuses out-of-scope requests without hallucinating', async () => {
    await say('hi');
    const refusal = await say('book me a submarine to atlantis');
    expect(refusal).toMatch(/Ticket \*WP-/);
    expect(refusal).not.toMatch(/₹/);
    const tickets = await getStore().listEscalations('OPEN');
    expect(tickets[0].reason).toBe('OUT_OF_SCOPE');
  });

  it('escalates a policy-sensitive question after giving the holding line', async () => {
    await say('hi');
    const visa = await say('do i need a visa for dubai');
    expect(visa).toMatch(/won't guess/i);
    expect((await getStore().listEscalations('OPEN'))[0].reason).toBe('POLICY_SENSITIVE');
  });

  it('answers a knowledge-base question without escalating', async () => {
    await say('hi');
    const kb = await say('what is the baggage allowance on domestic flights');
    expect(kb).toMatch(/15kg check-in/);
    expect(await getStore().listEscalations('OPEN')).toHaveLength(0);
  });

  it('records a knowledge gap event for the learning loop', async () => {
    await say('hi');
    await say('I want an agent');
    const store = getStore() as MemoryStore;
    expect(store.allEvents().some((e) => e.type === 'knowledge_gap')).toBe(true);
    expect(store.allEvents().some((e) => e.type === 'escalation_opened')).toBe(true);
  });
});

describe('agent control over WhatsApp', () => {
  // The owner is recognised by OWNER_WHATSAPP; config is read at import time,
  // so drive the command handler directly rather than through the channel.
  it('runs the full take → reply → hand-back loop', async () => {
    await say('hi');
    await say('I want to talk to a human');
    const ticket = (await getStore().listEscalations('OPEN'))[0].ticket;

    const list = await handleOwnerCommand('/tickets');
    expect(list.handled).toBe(true);
    expect(list.reply).toMatch(ticket);

    const brief = await handleOwnerCommand(`/ticket ${ticket}`);
    expect(brief.reply).toMatch(/Situation:/);
    expect(brief.reply).toMatch(/Suggested:/);

    const take = await handleOwnerCommand(`/take ${ticket}`);
    expect(take.reply).toMatch(/You have \*WP-/);
    expect((await getStore().getEscalation(ticket))!.status).toBe('CLAIMED');
    expect((await getStore().getSession((await getStore().getEscalation(ticket))!.sessionId))!.state).toBe(
      'HUMAN_CONTROL',
    );

    const before = channel.sent.length;
    const sent = await handleOwnerCommand(`/reply ${ticket} Infants under 2 travel on a parent's lap.`);
    expect(sent.reply).toMatch(/Sent to/);
    // The user sees an agent-attributed message, not a bot one. The name comes
    // from AGENT_NAME, so assert the shape rather than pinning one person.
    expect(channel.transcriptSince(before)).toMatch(/👤 \*[\w ]+ \(Waypoint\)\*/);
    expect(channel.transcriptSince(before)).toMatch(/Infants under 2/);

    const back = await handleOwnerCommand(`/bot ${ticket}`);
    expect(back.reply).toMatch(/resolved/);
    const resolved = await getStore().getEscalation(ticket);
    expect(resolved!.status).toBe('RESOLVED');

    // The bot is audible again and resumes in a state it can continue from.
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.control).toBe('BOT');
    expect(session!.state).not.toBe('HUMAN_CONTROL');
    const resumed = await say(`bangalore to dubai on ${DEPART}`);
    expect(resumed).toMatch(/BLR → DXB/);
  });

  it('rejects a command for a ticket that does not exist', async () => {
    const r = await handleOwnerCommand('/take WP-ZZZZ');
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/Couldn't find/);
  });

  it('explains itself rather than failing on a malformed command', async () => {
    expect((await handleOwnerCommand('/reply')).reply).toMatch(/Usage/);
    expect((await handleOwnerCommand('/help')).reply).toMatch(/agent commands/);
    expect((await handleOwnerCommand('/nonsense')).handled).toBe(false);
  });

  it('notifies the user and resumes safe self-service when the SLA lapses', async () => {
    await say('hi');
    await say('get me an agent');
    const ticket = (await getStore().listEscalations('OPEN'))[0].ticket;

    const before = channel.sent.length;
    // Pretend the SLA window has elapsed.
    const future = Date.now() + 11 * 60_000;
    const notified = await runSlaSweep(future);
    expect(notified).toBe(1);

    const messages = channel.transcriptSince(before);
    expect(messages).toMatch(/still tied up/);
    expect(messages).toMatch(ticket);

    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.control).toBe('BOT');

    // It only fires once, however many times the sweeper runs.
    expect(await runSlaSweep(future + 60_000)).toBe(0);
  });
});

describe('robustness', () => {
  it('ignores a replayed message rather than answering twice', async () => {
    const dup: InboundMessage = {
      channelUserId: 'dup-user',
      text: 'hello',
      timestamp: Date.now(),
      messageId: 'fixed-id-1',
    };
    await handleTurn(dup, channel);
    const after = channel.sent.length;
    await handleTurn(dup, channel);
    expect(channel.sent.length).toBe(after);
  });

  it('keeps separate sessions for separate users', async () => {
    await say('bangalore to dubai tomorrow', 'user-a');
    await say('hi', 'user-b');
    const a = await getStore().getSessionByChannelUser('memory', 'user-a');
    const b = await getStore().getSessionByChannelUser('memory', 'user-b');
    expect(a!.slots.trip.origin).toBe('BLR');
    expect(b!.slots.trip.origin).toBeUndefined();
  });

  it('survives five rapid messages without crashing or duplicating', async () => {
    const texts = ['hi', 'delhi', 'to goa', 'tomorrow', '1'];
    for (const [i, t] of texts.entries()) {
      await channel.userSays(t, 'rapid-user');
      expect(channel.sent.length).toBeGreaterThan(i); // every turn produced a reply
    }
  });

  it('starts over on request but keeps the person', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    const restarted = await say('start over');
    expect(restarted).toMatch(/Starting fresh/);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.offers).toBeNull();
    expect(session!.slots.trip.origin).toBeUndefined();
    expect(session!.slots.greeted).toBe(true); // it does not re-introduce itself
  });
});

describe('payment loop', () => {
  it('marks a booking paid and pushes a WhatsApp confirmation', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('1');
    await say('Rahul Sharma');
    await say('12/04/1992 male');
    await say('rahul@example.com 9876543210');

    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.state).toBe('CONFIRMING');
    await say('yes');

    const booking = await getStore().getBooking(
      (await getStore().getSessionByChannelUser('memory', 'e2e-user'))!.slots.bookingRef!,
    );
    expect(booking!.status).toBe('AWAITING_PAYMENT');

    const paid = await markPaid(booking!.ref);
    expect(paid!.status).toBe('PAID');
    expect(paid!.paidAt).toBeInstanceOf(Date);
  });
});

/** The option cards in a bot message, as the user reads them. */
function cardsIn(text: string) {
  return [
    ...text.matchAll(/🛫 (\d{2}:\d{2}) [A-Z]{3} → 🛬 (\d{2}:\d{2})(⁺\d)? [A-Z]{3}\n⏱ [^·]+· (non-stop|\d stops?)/g),
  ].map((m) => ({ depart: m[1], arrive: m[2], nextDay: Boolean(m[3]), nonStop: m[4] === 'non-stop' }));
}

describe('the WhatsApp conversation that exposed the dumb-bot bugs', () => {
  // The same turns a tester sent on WhatsApp, where the bot ignored "morning",
  // ignored "reaching before noon", showed one flight twice, escalated a clear
  // request to a human and then answered "Hi" with "reply 1, 2 or 3".

  async function upToOptions() {
    await say('Hi');
    await say('I need a flight from Delhi to Goa');
    return say('For tomorrow morning');
  }

  it('keeps "tomorrow morning" to morning departures — on a UTC server too', async () => {
    const options = await upToOptions();
    expect(options).toMatch(/departing 05:00–12:00/);
    const cards = cardsIn(options);
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.depart >= '05:00' && c.depart <= '12:00', `${c.depart} is not a morning departure`).toBe(true);
    }
  });

  it('applies "non stop and reaching before noon" to stops AND landing time, with no card twice', async () => {
    await upToOptions();
    const refined = await say('Give me only non stop flights and reaching before noon');
    expect(refined).toMatch(/non-stop/);
    expect(refined).toMatch(/landing by 12:00|lands by 12:00/);

    const flights = refined.match(/\b[A-Z0-9]{2}-\d{2,4}\b/g) ?? [];
    expect(new Set(flights).size).toBe(flights.length);

    // Either every card meets both constraints, or the bot says plainly which
    // one it could not meet — it never silently drops one.
    if (!/Nothing|No non-stop/.test(refined)) {
      for (const c of cardsIn(refined)) {
        expect(c.nonStop).toBe(true);
        expect(!c.nextDay && c.arrive <= '12:00', `lands ${c.arrive}`).toBe(true);
      }
    }
  });

  it('answers a restated deadline instead of shrugging, and never escalates it', async () => {
    await upToOptions();
    await say('Give me only non stop flights and reaching before noon');

    const again = await say('I need a flight reaching before noon');
    expect(again).not.toMatch(/didn't quite get|Reply \*1\*, \*2\* or \*3\* to pick one/);
    expect(again).toMatch(/landing by 12:00/);

    const third = await say('I need to reach before noon');
    expect(third).not.toMatch(/Ticket/);
    expect(await getStore().listEscalations()).toHaveLength(0);
  });

  it('greets a returning "Hi" with where the search stands', async () => {
    await upToOptions();
    const hi = await say('Hi');
    expect(hi).toMatch(/Hi again/);
    expect(hi).toMatch(/DEL → GOI/);
    expect(hi).toMatch(/departing 05:00–12:00/);
  });

  it('keeps an email typed mid-search for the itinerary instead of ignoring it', async () => {
    await upToOptions();
    const noted = await say('mayank@example.com');
    expect(noted).toMatch(/itinerary to mayank@example\.com/);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.draftPassenger.email).toBe('mayank@example.com');
  });
});

describe('handoffs the bot can come back from', () => {
  it('brings the options back when the user says yes to carrying on', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('I want to talk to a human');
    const offer = await say('mayank@example.com');
    expect(offer).toMatch(/want me to\?/);

    const resumed = await say('yes');
    expect(resumed).toMatch(/where we left off/);
    expect(resumed).toMatch(/\*1\.\*/);
  });

  it('does not swallow the next trip request after a handoff the bot started', async () => {
    await say('hi');
    expect(await say('do i need a visa for dubai')).toMatch(/won't guess/i);
    // The user ignores the email question and carries on planning.
    const search = await say(`bangalore to dubai on ${DEPART}`);
    expect(search).toMatch(/BLR → DXB/);
  });

  it('does not interrupt a user the bot is already helping with "still tied up"', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('I want to talk to a human');
    await say('mayank@example.com'); // the bot is talking to them again from here

    const before = channel.sent.length;
    expect(await runSlaSweep(Date.now() + 60 * 60_000)).toBe(1);
    expect(channel.transcriptSince(before)).not.toMatch(/still tied up/);
  });

  it('does not treat changing your mind twice as frustration', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say(`actually make it chennai to goa on ${DEPART}`);
    const second = await say(`actually mumbai to goa instead, on ${DEPART}`);
    expect(second).toMatch(/BOM → GOI/);
    expect(await getStore().listEscalations()).toHaveLength(0);
  });

  it('asks before handing off: two unclear messages get help, not a ticket', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    expect(await say('hmm')).toMatch(/I can narrow these down/);
    expect(await say('blah')).toMatch(/I can narrow these down/);
    expect(await getStore().listEscalations()).toHaveLength(0);
  });
});

describe('impossible constraints', () => {
  it('says which constraint cannot be met and leads with the flight closest to it', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    const out = await say('non-stop, landing before 5am');
    expect(out).toMatch(/lands by 05:00/);
    expect(out).toMatch(/Closest to your time/);
    expect(out).toMatch(/the closest lands at \d{2}:\d{2}/);
  });

  it('drops every filter on "show all"', async () => {
    await say('hi');
    await say(`delhi to goa on ${DEPART}`);
    await say('non-stop only');
    const all = await say('show all');
    expect(all).toMatch(/no filters/);
    const session = await getStore().getSessionByChannelUser('memory', 'e2e-user');
    expect(session!.slots.activeFilters?.nonStopOnly).toBeFalsy();
  });
});

describe('one turn at a time', () => {
  it('does not lose a message sent while the previous one is still being handled', async () => {
    // WhatsApp delivers "delhi to goa" / "<date>" as separate events. Handled
    // concurrently, the second turn saved over the first and the route was lost.
    await Promise.all([channel.userSays('delhi to goa', 'burst'), channel.userSays(`on ${DEPART}`, 'burst')]);
    const session = await getStore().getSessionByChannelUser('memory', 'burst');
    expect(session!.slots.trip.origin).toBe('DEL');
    expect(session!.slots.trip.departDate).toBeDefined();
    expect(session!.offers?.length).toBeGreaterThan(0);
  });
});

describe('outbound verification', () => {
  const offers = [
    {
      id: 'x',
      outbound: {
        segments: [{ flightNumber: '6E-1471', carrierCode: '6E' } as never],
        totalDurationMin: 100,
        stops: 0,
        layoverMin: [],
      },
      price: { total: 28_940, perAdult: 14_470, currency: 'INR' as const },
      cabin: 'ECONOMY' as const,
      refundable: false,
      baggage: { cabinKg: 7, checkInKg: 15 },
      provider: 'mock' as const,
    },
  ];

  it('passes text whose numbers all come from the offer cache', () => {
    expect(verifyOutbound('₹28,940 on 6E-1471', offers as never).ok).toBe(true);
  });

  it('blocks a fare that is not in the cache', () => {
    const r = verifyOutbound('I can do ₹9,999 for that', offers as never);
    expect(r.ok).toBe(false);
    expect(r.offending).toBe('₹9,999');
  });

  it('blocks a flight number that was never offered', () => {
    const r = verifyOutbound('Take AI-101 instead', offers as never);
    expect(r.ok).toBe(false);
    expect(r.offending).toBe('AI-101');
  });

  it('blocks everything when there is no offer cache at all', () => {
    expect(verifyOutbound('that will be ₹5,000', null).ok).toBe(false);
  });

  it('does not mistake our own booking reference for a flight number', () => {
    // WP-DD3268 contains "DD3268", which reads exactly like a flight number.
    expect(verifyOutbound('Itinerary WP-DD3268 confirmed', offers as never).ok).toBe(true);
    expect(verifyOutbound('Ticket WP-4F2A is open', offers as never).ok).toBe(true);
  });

  it('allows an amount the user themselves stated', () => {
    expect(verifyOutbound('Nothing under ₹5,000 on this route', offers as never).ok).toBe(false);
    expect(verifyOutbound('Nothing under ₹5,000 on this route', offers as never, [5000]).ok).toBe(true);
  });
});
