/**
 * Proves email works before it matters. Run this the moment credentials exist —
 * not at 11pm on submission night. It uses the same transport the bot will:
 * Brevo's HTTPS API when BREVO_API_KEY is set, SMTP otherwise.
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

console.log(
  config.hasBrevo
    ? `Transport: Brevo API  from: ${config.MAIL_FROM}`
    : `Transport: SMTP  host: ${config.SMTP_HOST || '(not set)'}  user: ${config.SMTP_USER || '(not set)'}`,
);

const check = await verifyEmail();
if (!check.ok) {
  console.error(`✖ Email verification failed: ${check.error}`);
  if (check.via === 'brevo') {
    console.error('  Check BREVO_API_KEY (Brevo → SMTP & API → API keys).');
  } else {
    console.error('  Gmail: enable 2-Step Verification, then create an App Password.');
    console.error('  On Render\'s free tier SMTP is blocked outright — set BREVO_API_KEY instead.');
  }
  process.exit(1);
}
console.log(`✔ ${check.via === 'brevo' ? 'Brevo key' : 'SMTP connection'} verified`);

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
  if (config.hasBrevo) console.error('  Brevo 400? MAIL_FROM must be a sender verified in Brevo (Senders & IP → Senders).');
  process.exit(1);
}
