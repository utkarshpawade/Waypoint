/**
 * Proves SMTP works before it matters. Run this the moment credentials exist —
 * not at 11pm on submission night.
 *
 *   npm run email:test -- you@example.com
 */
import { config } from '../src/config.js';
import { sendMail, verifyEmail } from '../src/email/service.js';
import { itineraryHtml, itinerarySubject, itineraryText } from '../src/email/templates/itinerary.html.js';
import { generateOffers } from '../src/flights/mock.js';
import { DateTime } from 'luxon';

const to = process.argv[2] ?? config.SMTP_USER;
if (!to) {
  console.error('✖ Give a recipient: npm run email:test -- you@example.com');
  process.exit(1);
}

console.log(`SMTP host: ${config.SMTP_HOST || '(not set)'}  user: ${config.SMTP_USER || '(not set)'}`);

const check = await verifyEmail();
if (!check.ok) {
  console.error(`✖ SMTP verification failed: ${check.error}`);
  console.error('  Gmail: enable 2-Step Verification, then create an App Password.');
  console.error('  Blocked or spam-foldered? Swap SMTP_* for a Brevo relay — same code path.');
  process.exit(1);
}
console.log('✔ SMTP connection verified');

const departDate = DateTime.now().plus({ days: 14 }).toISODate()!;
const offer = generateOffers({
  origin: 'BLR',
  destination: 'DXB',
  departDate,
  adults: 1,
  cabin: 'ECONOMY',
  currency: 'INR',
})[0];

const input = {
  ref: 'WP-TEST01',
  offer,
  passengers: [
    {
      bookingRef: 'WP-TEST01',
      seq: 1,
      fullName: 'Test Traveller',
      dob: '1992-04-12',
      gender: 'M',
      email: to,
      phone: '9876543210',
      passportNo: 'M1234567',
      passportExpiry: '2031-08-20',
      nationality: 'Indian',
    },
  ],
  trip: { origin: 'BLR', destination: 'DXB', departDate, adults: 1 },
  paymentLink: `${config.publicBaseUrl}/pay/WP-TEST01`,
  holdMinutes: 30,
};

const result = await sendMail({
  to,
  subject: itinerarySubject(input.ref, input.trip, offer),
  html: itineraryHtml(input),
  text: itineraryText(input),
});

if (result.ok) {
  console.log(`✔ Sent to ${to} (message id ${result.messageId})`);
  console.log('  Check the inbox AND the spam folder. Open it on a phone — that is where it will be read.');
} else {
  console.error(`✖ Send failed: ${result.error}`);
  process.exit(1);
}
