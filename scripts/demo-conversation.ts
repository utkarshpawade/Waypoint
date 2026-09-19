/**
 * Scripted end-to-end conversation against the in-memory channel and store.
 * No accounts, no network: `npx tsx scripts/demo-conversation.ts`
 *
 * Useful as a smoke test after a change, and as the fastest way to see the
 * whole flow without a phone.
 */
import { MemoryChannel } from '../src/channels/memory.js';
import { setActiveChannel } from '../src/channels/registry.js';
import { handleTurn } from '../src/conversation/engine.js';

const script = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'hey need flights',
      'bangalore to dubai next friday, 2 adults',
      'anything cheaper in the morning?',
      '3',
      'Rahul Sharma',
      '12/04/1992, male',
      'rahul.sharma@example.com, 9876543210',
      'M1234567, expires 20/08/2031, indian',
      'Priya Sharma',
      '03/11/1994 female',
      'priya.sharma@example.com 9876501234',
      'K7654321 expiry 12/12/2030 indian',
      'yes',
    ];

const channel = new MemoryChannel();
setActiveChannel(channel);
channel.onMessage((m) => handleTurn(m, channel));

for (const line of script) {
  console.log(`\n\x1b[36muser ▸\x1b[0m ${line}`);
  const before = channel.sent.length;
  await channel.userSays(line);
  for (const out of channel.sent.slice(before)) {
    const pretty = out.text
      .replace(/\*(.+?)\*/g, '\x1b[1m$1\x1b[0m')
      .replace(/_(.+?)_/g, '\x1b[3m$1\x1b[0m')
      .split('\n')
      .join('\n       ');
    console.log(`\x1b[32mbot  ▸\x1b[0m ${pretty}`);
  }
}
process.exit(0);
