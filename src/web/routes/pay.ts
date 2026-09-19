import { Router } from 'express';
import { getStore } from '../../db/index.js';
import { logger } from '../../logger.js';
import { sendTo } from '../../channels/registry.js';
import { markPaid } from '../../booking/service.js';
import { formatDuration, formatINR } from '../../flights/ranking.js';
import { dayLabel, hhmm, paymentConfirmedMessage, stopsLabel } from '../../conversation/formatter.js';
import type { BookingRecord } from '../../db/types.js';

const log = logger.child({ mod: 'pay' });

/**
 * The payment page. The loop this closes is the best moment in the build:
 * the user opens the email on their phone, taps the link, taps pay, and the
 * WhatsApp confirmation lands on the same screen seconds later.
 *
 * It is clearly labelled a demo and moves no money.
 */
export function payRouter(): Router {
  const router = Router();

  router.get('/pay/:ref', async (req, res) => {
    const booking = await getStore().getBooking(req.params.ref.toUpperCase());
    if (!booking) {
      res.status(404).type('html').send(page('Not found', '<p>That booking reference does not exist.</p>'));
      return;
    }
    res.type('html').send(bookingPage(booking));
  });

  router.post('/pay/:ref/simulate', async (req, res) => {
    const ref = req.params.ref.toUpperCase();
    const booking = await markPaid(ref);
    if (!booking) {
      res.status(404).json({ error: 'unknown booking' });
      return;
    }

    const session = await getStore().getSession(booking.sessionId);
    if (session) {
      const delivered = await sendTo(session.channelUserId, paymentConfirmedMessage(ref, booking.total));
      log.info({ ref, delivered }, 'payment confirmation pushed to WhatsApp');
      await getStore().insertMessage({
        sessionId: session.id,
        direction: 'OUT',
        author: 'BOT',
        body: paymentConfirmedMessage(ref, booking.total),
        intent: 'payment_confirmed',
      });
    }
    res.json({ ok: true, ref, status: 'PAID' });
  });

  return router;
}

function bookingPage(b: BookingRecord): string {
  const o = b.offer;
  const first = o.outbound.segments[0];
  const last = o.outbound.segments.at(-1)!;
  const paid = b.status === 'PAID';

  const body = `
    <div class="card">
      <div class="row"><span class="ref">${b.ref}</span>
        <span class="badge ${paid ? 'paid' : 'held'}">${paid ? 'PAID' : 'AWAITING PAYMENT'}</span></div>

      <div class="leg">
        <div class="times">
          <div><strong>${hhmm(first.departISO)}</strong><span>${first.from}</span></div>
          <div class="mid">${formatDuration(o.outbound.totalDurationMin)}<br><small>${stopsLabel(o.outbound)}</small></div>
          <div class="right"><strong>${hhmm(last.arriveISO)}</strong><span>${last.to}</span></div>
        </div>
        <div class="date">${dayLabel(first.departISO)}</div>
        ${o.outbound.segments
          .map(
            (s) =>
              `<div class="seg">${s.carrierName} ${s.flightNumber} · ${hhmm(s.departISO)} ${s.from} → ${hhmm(
                s.arriveISO,
              )} ${s.to}</div>`,
          )
          .join('')}
      </div>

      <div class="total"><span>Total</span><strong>${formatINR(b.total)}</strong></div>

      ${
        paid
          ? `<div class="done">✅ Payment confirmed. A confirmation has been sent on WhatsApp.</div>`
          : `<button id="pay">Simulate successful payment — ${formatINR(b.total)}</button>
             <p class="note">This is a portfolio demo. No card is collected and no money moves.
             Tapping the button marks the booking paid and sends a WhatsApp confirmation.</p>`
      }
    </div>
    <script>
      const btn = document.getElementById('pay');
      if (btn) btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Processing…';
        const res = await fetch(location.pathname + '/simulate', { method: 'POST' });
        if (res.ok) location.reload(); else { btn.disabled = false; btn.textContent = 'Try again'; }
      });
    </script>`;
  return page(`Waypoint ${b.ref}`, body);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --ink:#1b1b1b; --muted:#6c757d; --line:#e5e5e5; --brand:#0f5132; --accent:#198754; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131516; --card:#1c1f20; --ink:#f2f2f2; --muted:#9aa0a6; --line:#2e3233; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  .card { max-width:460px; margin:0 auto; background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:22px; }
  .row { display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; }
  .ref { font-weight:700; font-size:18px; letter-spacing:.5px; }
  .badge { font-size:11px; font-weight:700; letter-spacing:.6px; padding:5px 9px; border-radius:20px; }
  .badge.held { background:#fff3cd; color:#7a5c00; }
  .badge.paid { background:#d1e7dd; color:#0f5132; }
  .leg { border:1px solid var(--line); border-radius:10px; padding:14px; }
  .times { display:flex; justify-content:space-between; align-items:center; }
  .times strong { font-size:24px; display:block; }
  .times span { color:var(--muted); font-size:13px; }
  .times .right { text-align:right; }
  .mid { text-align:center; color:var(--muted); font-size:12px; }
  .date { color:var(--muted); font-size:13px; margin-top:6px; }
  .seg { border-top:1px solid var(--line); margin-top:10px; padding-top:10px; font-size:13px; }
  .total { display:flex; justify-content:space-between; margin:20px 0; padding-top:14px;
           border-top:2px solid var(--ink); font-size:18px; }
  button { width:100%; padding:15px; font-size:16px; font-weight:700; color:#fff; background:var(--accent);
           border:0; border-radius:10px; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  .note, .done { font-size:12.5px; color:var(--muted); margin-top:14px; }
  .done { background:#d1e7dd; color:#0f5132; padding:14px; border-radius:10px; font-size:14px; }
</style></head><body>${body}</body></html>`;
}
