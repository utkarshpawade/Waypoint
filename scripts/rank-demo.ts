import { DateTime } from 'luxon';
import { MockProvider } from '../src/flights/mock.js';
import { formatDuration, formatINR, topThree } from '../src/flights/ranking.js';
import type { SearchQuery } from '../src/flights/types.js';

const [origin = 'BLR', destination = 'DXB', days = '7'] = process.argv.slice(2);

const q: SearchQuery = {
  origin,
  destination,
  departDate: DateTime.now().setZone('Asia/Kolkata').plus({ days: Number(days) }).toISODate()!,
  adults: 2,
  cabin: 'ECONOMY',
  currency: 'INR',
};

const offers = await new MockProvider().search(q);
console.log(`\n${offers.length} offers for ${origin} → ${destination} on ${q.departDate}\n`);

for (const p of topThree(offers)) {
  const seg = p.offer.outbound.segments[0];
  const last = p.offer.outbound.segments.at(-1)!;
  const label = { CHEAPEST: '💰 Cheapest', FASTEST: '⚡ Fastest', BEST_VALUE: '⭐ Best value' }[p.label];
  console.log(`${label} — ${formatINR(p.offer.price.total)} (score ${p.score.toFixed(3)})`);
  console.log(
    `  ${seg.carrierName} ${seg.flightNumber} · ${seg.departISO.slice(11, 16)} → ${last.arriveISO.slice(11, 16)}` +
      ` · ${formatDuration(p.offer.outbound.totalDurationMin)} · ${
        p.offer.outbound.stops === 0 ? 'non-stop' : `${p.offer.outbound.stops} stop`
      }`,
  );
  console.log(`  ${p.whyThisOne}\n`);
}
