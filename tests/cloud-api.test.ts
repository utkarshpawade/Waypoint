import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloudApiChannel, extractMessages, splitForCloud } from '../src/channels/cloud-api.js';

/** A realistic inbound text delivery. */
function delivery(messages: unknown[], contacts: unknown[] = [{ wa_id: '919876543210', profile: { name: 'Rahul' } }]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1234',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', metadata: {}, contacts, messages },
          },
        ],
      },
    ],
  };
}

const TEXT_MESSAGE = {
  from: '919876543210',
  id: 'wamid.HBgMOTE3ODM4NDQ3NTcwFQIAEhgg',
  timestamp: '1789800000',
  type: 'text',
  text: { body: 'bangalore to dubai next friday' },
};

describe('webhook parsing', () => {
  it('extracts a text message with sender, id and profile name', () => {
    const [m] = extractMessages(delivery([TEXT_MESSAGE]));
    expect(m.channelUserId).toBe('919876543210');
    expect(m.text).toBe('bangalore to dubai next friday');
    expect(m.messageId).toBe('wamid.HBgMOTE3ODM4NDQ3NTcwFQIAEhgg');
    expect(m.name).toBe('Rahul');
    expect(m.timestamp).toBe(1789800000 * 1000);
  });

  it('ignores delivery and read status callbacks', () => {
    const statusOnly = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] } }] }],
    };
    expect(extractMessages(statusOnly)).toEqual([]);
  });

  it('reads a reply-quoted message, where the text sits under context', () => {
    const quoted = {
      ...TEXT_MESSAGE,
      id: 'wamid.quoted',
      context: { from: '919999999999', id: 'wamid.original' },
      text: { body: '3' },
    };
    const [m] = extractMessages(delivery([quoted]));
    expect(m.text).toBe('3');
  });

  it('surfaces a non-text message as empty rather than dropping it', () => {
    const image = { from: '919876543210', id: 'wamid.img', timestamp: '1789800000', type: 'image', image: { id: 'x' } };
    const [m] = extractMessages(delivery([image]));
    expect(m.text).toBe('');
    expect(m.channelUserId).toBe('919876543210');
  });

  it('handles several messages in one delivery', () => {
    const msgs = extractMessages(
      delivery([TEXT_MESSAGE, { ...TEXT_MESSAGE, id: 'wamid.second', text: { body: '2 adults' } }]),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1].text).toBe('2 adults');
  });

  it('survives malformed or empty payloads without throwing', () => {
    expect(extractMessages({})).toEqual([]);
    expect(extractMessages(null)).toEqual([]);
    expect(extractMessages({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
    expect(extractMessages({ entry: [{ changes: [{ value: { messages: [{}] } }] }] })).toEqual([]);
  });
});

describe('subscription handshake', () => {
  const ch = new CloudApiChannel();

  it('echoes the challenge when the verify token matches', () => {
    // The default verify token when the env var is unset.
    const challenge = ch.verifySubscription({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'waypoint-verify',
      'hub.challenge': '1158201444',
    });
    expect(challenge).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode, or a missing challenge', () => {
    expect(ch.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' })).toBeNull();
    expect(ch.verifySubscription({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'waypoint-verify', 'hub.challenge': 'x' })).toBeNull();
    expect(ch.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'waypoint-verify' })).toBeNull();
  });
});

describe('signature verification', () => {
  const ch = new CloudApiChannel();

  it('accepts a correctly signed body', () => {
    // WA_CLOUD_APP_SECRET is blank in tests, so signing is not enforced —
    // which is itself the documented behaviour, and worth pinning.
    const body = Buffer.from(JSON.stringify(delivery([TEXT_MESSAGE])));
    const sig = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    expect(ch.verifySignature(body, sig)).toBe(true);
  });

  it('does not throw on a missing or malformed header', () => {
    const body = Buffer.from('{}');
    expect(() => ch.verifySignature(body, undefined)).not.toThrow();
    expect(() => ch.verifySignature(undefined, 'sha256=abcd')).not.toThrow();
    expect(() => ch.verifySignature(body, 'garbage')).not.toThrow();
  });
});

describe('message splitting', () => {
  it('leaves a message inside the limit alone', () => {
    expect(splitForCloud('short')).toEqual(['short']);
  });

  it('splits long text on paragraph boundaries within the API limit', () => {
    const long = Array.from({ length: 30 }, () => 'x'.repeat(200)).join('\n\n');
    const parts = splitForCloud(long, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join('\n\n')).toBe(long);
  });
});

describe('channel contract', () => {
  it('reports its status without credentials rather than crashing', () => {
    const s = new CloudApiChannel().status();
    expect(s.connected).toBe(false);
    expect(s.state).toBe('not configured');
  });

  it('refuses to start without credentials, with a message that says which', async () => {
    await expect(new CloudApiChannel().start()).rejects.toThrow(/WA_CLOUD_TOKEN/);
  });

  it('presents itself as the same channel name as the Baileys adapter', () => {
    // Nothing downstream should be able to tell the transports apart.
    expect(new CloudApiChannel().name).toBe('whatsapp');
  });
});
