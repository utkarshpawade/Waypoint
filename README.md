# Waypoint ✈️ — a WhatsApp flight concierge

A non-official WhatsApp bot that searches flights, explains **why one option is
the right one**, collects passenger details, emails an itinerary with a payment
link — and, when it hits something it shouldn't guess at, hands the conversation
to a human **on WhatsApp**, not to a dashboard nobody is watching at 11pm.

> **Live number:** `+__ _____ _____` &nbsp;·&nbsp; **Demo video:** _<link>_
> &nbsp;·&nbsp; **Console:** `https://<your-app>.onrender.com/console?token=…`
>
> _(Fill these three in before submitting — see “Deploying” below.)_

```
User: bangalore to dubai next friday, 2 adults
Bot:  Got it — BLR → DXB (Bengaluru to Dubai), Fri 2 Oct, 2 adults, economy.
      Searching fares… ⏱

Bot:  Here are the three that matter 👇

      1. 💰 Cheapest — ₹20,440 for 2
      Scoot TR-862 · 🛫 23:10 BLR → 🛬 14:44⁺1 DXB
      ⏱ 17h 04m · 1 stop · SIN · 🧳 20kg
      ₹4,360 less than the next option — but it's a 23:10 departure.

      2. ⚡ Fastest — ₹26,220 for 2
      Emirates EK-369 · 🛫 21:40 BLR → 🛬 00:07⁺1 DXB
      ⏱ 3h 57m · non-stop · 🧳 30kg
      Quickest by 2h 16m and non-stop — but it's a 21:40 departure.

      3. ⭐ Best value — ₹24,800 for 2
      flydubai FZ-555 · 🛫 09:10 BLR → 🛬 13:53 DXB
      ⏱ 6h 13m · 1 stop · BOM · 🧳 20kg
      10h 51m shorter than the cheapest for ₹4,360 more.

      Reply 1, 2 or 3 — or tell me what to change.
```

Those italic lines are the point of the project. They are computed from the
numbers, never written by the model.

---

## Quickstart

It runs with **no accounts and no API keys**. Postgres, Gemini and SMTP are all
optional upgrades, and the code path is identical with or without them.

```bash
npm install
npx tsx scripts/demo-conversation.ts   # the whole flow, scripted, in your terminal
npm test                               # 134 tests
npm run cli                            # talk to it yourself
```

To run it for real:

```bash
cp .env.example .env    # fill in what you have
npm run db:push         # creates the schema in Neon (skip if no DATABASE_URL)
npm start               # then GET /admin/pair?token=…&phone=91XXXXXXXXXX
```

Open **WhatsApp → Settings → Linked devices → Link with phone number instead**
on the bot's phone and type the 8-character code. `/admin/qr?token=…` serves a
scannable PNG if you'd rather.

> Use a **spare number**. Baileys is an unofficial client and there is real ban
> risk; this is a portfolio project, not a production integration.

---

## Architecture

```
  Interviewer's phone ──WhatsApp──┐
                                  │
   ┌──────────────────────────────▼──────────────────────────────────┐
   │              RENDER (free web service, always-on)               │
   │                                                                 │
   │  ┌─────────────────────┐        ┌────────────────────────────┐  │
   │  │  Baileys socket     │        │  Express                   │  │
   │  │  • auto-reconnect   │        │  /health   keep-alive+state│  │
   │  │  • outbound queue   │        │  /admin/pair  pairing code │  │
   │  │  • owner commands   │        │  /pay/:ref    payment page │  │
   │  └──────────┬──────────┘        │  /console     agent UI+SSE │  │
   │             │   Channel iface   └────────────┬───────────────┘  │
   │  ┌──────────▼────────────────────────────────▼───────────────┐  │
   │  │             Conversation engine (FSM-driven)              │  │
   │  │   session ▸ interpret ▸ state router ▸ formatter          │  │
   │  │        │                    │                  │          │  │
   │  │  ┌─────▼──────┐   ┌─────────▼────────┐  ┌──────▼───────┐  │  │
   │  │  │ LLM layer  │   │ Escalation policy│  │  Response    │  │  │
   │  │  │ + rules    │   │  (pure, tested)  │  │  formatter   │  │  │
   │  │  │  fallback  │   └──────────────────┘  └──────────────┘  │  │
   │  │  └─────┬──────┘                                           │  │
   │  └────────┼──────────────────────────────────────────────────┘  │
   │     ┌─────┴──────┬────────────┬──────────────┬───────────────┐  │
   │     ▼            ▼            ▼              ▼               ▼  │
   │  Flights     Ranking      Booking +       Email          Escal. │
   │  mock/       (pure fn)    itinerary       nodemailer     service│
   │  amadeus                                  → SMTP                │
   └──────────────────────────┬──────────────────────────────────────┘
                              │
              ┌───────────────▼────────────────┐        ┌──────────────┐
              │   NEON POSTGRES (free)         │◀───────│ cron-job.org │
              │   wa_auth · sessions · messages│  ping  │  /health     │
              │   bookings · passengers        │  10min │  keeps awake │
              │   escalations · events         │        └──────────────┘
              └────────────────────────────────┘
```

**One process.** Render's free tier gives one service, so Express and the
WhatsApp socket share it — which also lets `/health` report whether WhatsApp is
genuinely connected rather than just whether Node is alive.

```
src/
  channels/     Channel interface · baileys · baileys-auth · cli · memory · registry
  conversation/ engine · states · interpret · session · prompts · tools · formatter · kb
  flights/      types · provider · mock · amadeus · ranking ★ · airports · airlines
  booking/      service · passenger
  email/        service · templates/itinerary.html
  escalation/   policy ★ · brief · service · owner-commands · gaps
  llm/          client · rules-fallback ★
  web/          server · sse · routes/{health,admin,pay,console}
  db/           types (Store interface) · repositories (Postgres) · memory-store · schema.sql
  metrics/      analytics
```

---

## Design decisions

### 1. The LLM interprets. The state machine decides.

The model never controls the flow and never states a fact it wasn't handed. Each
turn it returns JSON: an intent, a confidence, extracted slots, and **a proposed
tool**. Then [`engine.ts`](src/conversation/engine.ts) checks the proposal
against the current state's allow-list in [`states.ts`](src/conversation/states.ts),
validates the arguments with zod in [`tools.ts`](src/conversation/tools.ts), and
executes it itself. A proposal the state doesn't permit is dropped.

Three things follow from that:

- **The conversation layer is unit-testable.** It's a finite state machine, so
  the whole flow is covered by [`conversation.e2e.test.ts`](tests/conversation.e2e.test.ts)
  with no network and no model.
- **It cannot invent a fare.** Fares, times and flight numbers come only from
  tool results — enforced by a programmatic post-check (below).
- **A free Flash-class model is enough**, because the model isn't in charge.

### 2. Dates and cities are arithmetic, not inference

`"next friday"` is resolved by luxon in `Asia/Kolkata`; `"bangalore"` is resolved
by a lookup table of ~120 airports with aliases. The model is never allowed to
override either — it can only fill a slot the regexes missed, and only if the
value survives validation (an unknown IATA code or a past date is dropped, not
questioned). A model that gets a date wrong books the wrong flight.

A city with two airports gets one disambiguation question — *"London has more
than one airport — LHR (Heathrow) or LGW (Gatwick)?"* — unless one is clearly the
default (Goa → GOI), which is a `primary` flag in the data rather than a special
case in the code.

### 3. "Best flight" is a weighted score, and the bot shows its working

[`ranking.ts`](src/flights/ranking.ts) is a pure function over six factors:

| Preference | price | duration | stops | comfort | layover | carrier |
|---|---|---|---|---|---|---|
| `CHEAPEST` | 0.75 | 0.10 | 0.05 | 0.02 | 0.03 | 0.05 |
| `FASTEST` | 0.10 | 0.55 | 0.20 | 0.03 | 0.07 | 0.05 |
| **`BEST_VALUE`** *(default)* | **0.40** | **0.25** | **0.12** | **0.08** | **0.08** | **0.07** |
| `COMFORT` | 0.15 | 0.20 | 0.20 | 0.15 | 0.15 | 0.15 |

Price and duration are min-max normalised across the candidate set (their
absolute scale is route-dependent). Departure comfort, layover quality and
carrier score are **absolute** 0–1 scores, so a 3am departure is still penalised
even when every candidate is a red-eye. Lowest total score wins.

The user sees exactly three labelled picks — 💰 Cheapest, ⚡ Fastest, ⭐ Best
value — deduped, so if one flight would win two labels the second label takes the
runner-up and you always get three real choices. The 💰 and ⚡ labels are always
literally the cheapest and the shortest; only ⭐ is a judgement.

Each pick carries a **`whyThisOne`** line built by diffing it against the other
two and surfacing the largest real deltas — an advantage and its catch:

> *"10h 51m shorter than the cheapest for ₹4,360 more."*
> *"₹4,360 less than the next option — but it's a 23:10 departure."*

Users don't want ten options. They want to know why this one.

### 4. Escalation is a product surface, not a failure path

A handoff that assumes someone is watching a dashboard doesn't work at 11pm. So
when [`policy.ts`](src/escalation/policy.ts) fires, the bot:

1. Opens a ticket and mutes itself.
2. Tells the user the truth **once**, in three lines, with no apology spiral —
   and outside business hours states the real next-available time instead of
   promising an SLA it can't hit.
3. **Messages the on-call human on their own WhatsApp** with the handoff brief
   and the commands inline:

```
🔔 Escalation WP-4F2A · reason: KNOWLEDGE_GAP
From: +9198•••210 (Rahul) · waiting 0m

Situation: User asked whether an 11-month-old needs a separate seat on
BLR→DXB. Not in the KB; the bot refused to guess.
Trip: BLR→DXB · 2026-10-02 · 2 adults + 1 infant · economy
Blocker: An adjacent question with no knowledge-base entry.
Last msg: "so do i need to buy a seat for the baby or not"

Suggested reply: Infants under 2 travel on a parent's lap…

↳ /take WP-4F2A          ↳ /reply WP-4F2A <text>
↳ /bot WP-4F2A           ↳ /tickets
```

`/reply` relays to the user prefixed `👤 *Priya (Waypoint)*:` — they can't tell
the transport changed. `/bot` hands back, and the bot resumes in a state it can
actually continue from. The same actions exist in the browser console at
`/console?token=…`, which is the nicer surface when you're at a desk.

**If nobody answers:** after `ESCALATION_SLA_MINUTES` the bot goes back to the
user itself — honest about the delay, giving the real next-available time, and
offering to carry on with the parts it can safely do alone. It then resumes
self-service while the ticket stays open.

The eight triggers, all pure and tested:

| Reason | Fires when |
|---|---|
| `USER_REQUESTED_HUMAN` | "agent", "human", "talk to someone", "customer care" |
| `PROVIDER_FAILURE` | Search, model or email failed after its retries |
| `POLICY_SENSITIVE` | Refunds, medical, unaccompanied minors, visas, pets, groups > 9 |
| `HIGH_VALUE` | Quote over ₹1,50,000 |
| `OUT_OF_SCOPE` | Outside flights and booking, and not in the KB |
| `KNOWLEDGE_GAP` | Adjacent question with no KB match |
| `NEGATIVE_SENTIMENT` | Frustration markers, or 2+ corrections in 3 turns |
| `LOW_CONFIDENCE_REPEATED` | Two consecutive turns under 0.55 confidence |

The handoff brief is one LLM call **with a template fallback** — escalation must
never depend on the model working, since a broken model is one of the reasons to
escalate in the first place.

### 5. Two guards against making things up

**The knowledge base refuses rather than improvises.** [`data/kb.json`](data/kb.json)
holds 13 curated answers, each with a `source`. Entries about refunds, visas and
unaccompanied minors are marked `Escalate:` — the user gets an honest holding
line and a human gets the ticket. No KB match on an adjacent question means
`KNOWLEDGE_GAP`, never a guess.

**Every outbound message is checked before it is sent.**
[`verifyOutbound()`](src/conversation/engine.ts) scans for ₹ amounts and flight
numbers and rejects anything not in the session's offer cache. It accepts real
fares, exact **differences** between two real fares (that's what the explanation
lines quote), and amounts the user themselves stated. Anything else is
suppressed, logged as `hallucination_blocked`, and escalated.

### 6. Built to survive free infrastructure

Free tiers aren't a constraint to apologise for — they forced three real
engineering decisions:

- **Baileys, not `whatsapp-web.js`.** The latter drives a headless Chromium and
  needs ~700MB–1GB. Baileys speaks the protocol over a WebSocket in ~150MB, which
  fits in Render's 512MB. It also supports pairing codes, which beats scanning a
  QR out of a cloud log viewer.
- **The WhatsApp session lives in Postgres.** Render's free tier has no
  persistent disk, so `useMultiFileAuthState` would demand a fresh pairing on
  every restart, redeploy and sleep cycle — the interviewer would message a dead
  number. [`baileys-auth.ts`](src/channels/baileys-auth.ts) implements
  `AuthenticationState` over a `wa_auth` table, serialising through Baileys'
  `BufferJSON` (credentials contain Buffers; plain `JSON.stringify` corrupts them
  silently — that is the single most likely way this breaks).
- **The model is swappable and optional.** Three env vars move it between Groq,
  Gemini and OpenRouter. On 429s it backs off, then trips a circuit breaker,
  then falls back to [`rules-fallback.ts`](src/llm/rules-fallback.ts) — which can
  drive the entire happy path on its own. The e2e suite runs with no key at all,
  which is the proof.

  That portability paid for itself immediately: both model names the plan
  specified had been retired by the time this was built. Swapping providers was
  three lines of `.env`. Measured on the same interpretation prompt:

  | Provider | Model | Latency | Note |
  |---|---|---|---|
  | **Groq** | `openai/gpt-oss-120b` | **~0.9s** | default — clean JSON first time |
  | Gemini | `gemini-3.6-flash` | ~5.8s | works, but spends ~600 reasoning tokens per call |
  | Gemini | `gemini-flash-latest` | ~19.7s | too slow for a chat reply |

  The model sits on the critical path of a WhatsApp reply, so latency decided
  it. Note the token budget: a reasoning model counts its own thinking against
  `max_tokens`, so a 58-token answer can cost 700 — set too low, the JSON comes
  back truncated.

### 7. The provider can't break the demo

`FLIGHT_PROVIDER=mock` is the default. The Amadeus adapter is wrapped in a
decorator that falls back to the mock on any error or 5s timeout, so a
third-party outage can't ruin a live test.

The mock is **seeded by `hash(origin + destination + date + cabin)`** — the same
query always returns the same flights, which makes demos reproducible and tests
deterministic. Fares come from a distance model: `base = 1800 + km × 3.2`, then
multiplied by cabin, days-to-departure, weekend, non-stop and red-eye factors
with ±8% seeded jitter. Routings connect through plausible hubs, and airlines
connect through **their own** hub (routing Scoot via Istanbul is the kind of
detail that makes mock data look like mock data).

---

## The payment loop

Selecting a flight issues a **quote**, never a ticket — and every string says so.
The itinerary email carries a link to `/pay/:ref`, a mobile-first page with a
**Simulate successful payment** button that flips the booking to `PAID` and fires
a WhatsApp confirmation back to the user.

Opening the email on a phone, tapping the link, tapping pay, and watching the
WhatsApp confirmation land on the same screen is the best fifteen seconds in
this build.

---

## Testing

```bash
npm test          # 134 tests, no network, no model, no database
npm run typecheck
```

| Suite | What it pins down |
|---|---|
| `ranking.test.ts` | Normalisation, the weight table, label dedupe, and that **no explanation line quotes a number that isn't a real delta** |
| `escalation-policy.test.ts` | All eight triggers, precedence between them, streak bookkeeping, business hours across midnight |
| `rules-fallback.test.ts` | Date arithmetic against a frozen clock, route extraction, budget shorthand ("30k", "1.5 lakh"), intent classification |
| `passenger-validation.test.ts` | Field-level validation, international-only passport rules, DOB and expiry sanity |
| `formatter.test.ts` | Card shape and length, local-time rendering, next-day arrivals, passport masking, message splitting |
| `conversation.e2e.test.ts` | The whole flow through the real engine: search → refine → select → passengers → quote, plus escalation, disambiguation, idempotent replays, session isolation and the anti-hallucination guard |

Three of these suites found real bugs while being written — `day after tomorrow`
resolving to tomorrow, "me and my wife" counting as one passenger, and connecting
segments losing their timezone so an itinerary rendered as arriving before it
departed. That last one only showed up because the test rendered a real
multi-segment card.

---

## Deploying

Everything below is free and needs no card.

1. **Neon** → new project → copy the connection string into `DATABASE_URL`.
   Run `npm run db:push`.
2. **Groq** (console.groq.com) → API key → `LLM_API_KEY`, with
   `LLM_MODEL=openai/gpt-oss-120b`. Google AI Studio works too — see the table
   above for why Groq is the default. Either is optional: without a key the bot
   runs on rules alone and says less, but still works.

   Model names go stale. To see what a key can actually reach:
   ```bash
   curl -H "Authorization: Bearer $LLM_API_KEY" "$LLM_BASE_URL/models"
   ```
3. **Gmail** → 2-Step Verification → App Password → `SMTP_*`. Run
   `npm run email:test -- you@example.com` **now**, not later. If Gmail blocks or
   spam-folders it, swap in a Brevo relay — same code path.
4. **Render** → New Web Service from this repo (or use [`render.yaml`](render.yaml)).
   Build `npm ci`, start `npm start`, health check `/health`, free instance.
   Paste the env vars in.
5. After the first deploy, set `PUBLIC_BASE_URL` to the Render URL and
   **redeploy** — the payment links in itinerary emails are built from it.
6. `GET /admin/pair?token=…&phone=91XXXXXXXXXX`, then link the bot's phone.
7. **cron-job.org** → ping `https://<app>.onrender.com/health` every 10 minutes,
   so Render never sleeps. It doubles as uptime monitoring: the response says
   whether WhatsApp is actually connected.

**Prove the session survives a restart.** Restart the Render service twice and
message the bot after each. If it reconnects without re-pairing, the riskiest
part of this build is working.

---

## Known limitations

Stated plainly, because they matter more than the feature list:

- **Baileys is an unofficial client.** It is against WhatsApp's terms at scale
  and carries a genuine ban risk. Production would use the WhatsApp Cloud API —
  which is a one-file change, because nothing downstream of
  [`channels/types.ts`](src/channels/types.ts) imports Baileys.
- **Fares are simulated.** The mock is deterministic and plausible, not real. The
  Amadeus adapter exists and works, but its test tier covers limited routes and
  serves stale prices, so it isn't the default.
- **No real payments.** `/pay/:ref` is a demo page. Nothing is ticketed, ever,
  and every user-facing string says so.
- **Console auth is a shared token.** Fine for one operator and a demo; real auth
  is the first thing to replace.
- **Airline `qualityScore` is hand-assigned editorial data**, not a live on-time
  feed. It's documented as such in [`airlines.json`](data/airlines.json) and never
  contributes more than 15% of a ranking score.
- **English only**, and Hinglish only incidentally. Indian users code-switch
  constantly; the regex layer would need real work for that.
- **Metrics need Postgres.** They're plain SQL over the `events` table, so the
  in-memory store returns an empty set rather than a wrong number.

## What I'd build next

The `events` table already records every escalation with the user's exact words,
and every resolution with what the human replied. Ranked by frequency, that list
*is* the backlog — it says precisely which questions the bot should learn to
answer next. The console shows it as a knowledge-gap register today; the next
step is closing the loop by turning a resolved ticket into a KB entry in one
click, with the agent's own wording.

After that, in order: the Cloud API migration, real fare inventory, and
Hinglish.
