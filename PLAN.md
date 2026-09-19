# Waypoint — WhatsApp Flight Concierge
### Build plan & design document — v2, **deploy-first** (Agentropic, Product Engineering Intern)

> **Audience:** the engineer (or Claude Code session) implementing this from scratch.
> **Hard constraints driving v2:** ① the interviewer will test the bot **personally, on his own phone, at a time you don't control** → it must be **publicly deployed and always-on**. ② **Zero rupees spent.** ③ Done by **midnight tonight (Sat 19 Sep)**.
> **Read §0 → §3 before writing any code.** Then execute §13 phase by phase. §14 is the cut-list.

---

## 0. DO THESE SIX THINGS FIRST (~20 min, all free, no card)

Start these now — they're signups, they block code, and they can all run in parallel in browser tabs.

| # | Account | Where | Used for | Card? |
|---|---|---|---|---|
| 1 | **Google AI Studio** key | aistudio.google.com → Get API key | The LLM (Gemini Flash free tier) | No |
| 2 | **Neon Postgres** | neon.tech → new project, copy connection string | All state **+ the WhatsApp session** (critical — see §2.3) | No |
| 3 | **Render** | render.com → sign up with GitHub | Hosting, free web service | No |
| 4 | **Gmail App Password** | myaccount.google.com → Security → 2-Step Verification (enable) → App passwords | Emailing the itinerary + payment link to *any* address | No |
| 5 | **cron-job.org** | cron-job.org → free account | Keep-alive pinger so Render never sleeps | No |
| 6 | **GitHub repo** (public) | — | Render deploys from it; also your submission | No |

Plus one physical thing: **a spare phone number with WhatsApp.** Baileys is an unofficial client — there is real ban risk. Do not use your primary number.

> **Amadeus is now optional and deprioritised.** Real flight data is a nice-to-have; a deployed, working bot is the assignment. Only add it in P8 if you're ahead. The mock provider (§6.4) is the default.

---

## 1. The brief, restated

A **non-official WhatsApp bot** that acts as a flight-booking concierge:

1. User messages it in natural language — *"blr to dubai next friday, 2 people"*.
2. It extracts intent + trip details and asks only for what's genuinely missing.
3. It returns **the best options with reasoning** — cheapest / fastest / best-value, with fares, timings, stops, duration. Not a dump.
4. User picks one; bot collects passenger details.
5. Bot posts a **formatted itinerary** on WhatsApp **and emails** it with a **sample payment link** (no real gateway — the email landing is the stated deliverable).
6. When it can't handle something it **must not blabber or invent**. It escalates to a human, honestly, with context and a live takeover path.

**New for v2:** all of the above has to work when a stranger messages a public number at 11pm while your laptop is shut.

---

## 2. The three decisions that define v2

### 2.1 Baileys, not `whatsapp-web.js` — this is the whole reason deployment is possible

| | `whatsapp-web.js` | **`@whiskeysockets/baileys`** ✅ |
|---|---|---|
| How it works | Puppeteer driving a real Chromium running WhatsApp Web | Pure TypeScript WebSocket client speaking the protocol directly |
| RAM | ~700MB–1GB | **~120–200MB** |
| Free-tier viable | No | **Yes** |
| Non-official | Yes | Yes |
| Login | QR only | QR **or pairing code** (see §5.3 — much better for a headless server) |

Everything in v1 that said "you can't deploy this" was a consequence of Chromium. Remove Chromium, the problem disappears.

### 2.2 The LLM interprets; a state machine decides

Gemini never controls the flow and never states a fact it wasn't handed. It extracts slots and picks tools; a deterministic FSM owns every transition; fares and times come **only** from tool results, enforced by a post-check (§10.6). Result: no hallucinated prices, unit-testable conversation logic, no blabbering — and it means a *free Flash-class model is sufficient*, because the model isn't in charge.

### 2.3 Session state lives in Postgres, not on disk

Render's free tier has **no persistent disk**. If the Baileys auth credentials live in files (`useMultiFileAuthState`), every restart, redeploy and sleep-cycle logs the bot out and demands a fresh QR scan. That would be fatal — the interviewer would message a dead number.

So: **write a custom Baileys `AuthenticationState` backed by Postgres** (§5.4). Restarts then reconnect silently. This is the single highest-risk piece of the build; do it in P1 and prove it by redeploying twice.

---

## 3. Architecture

**One process.** Render's free tier gives one service, so Express and the Baileys socket share a process — which is also simpler, and lets the health endpoint that keeps the dyno awake report the WhatsApp connection state.

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
   │  │  • owner commands   │        │  /admin/qr    QR fallback  │  │
   │  └──────────┬──────────┘        │  /pay/:ref    payment page │  │
   │             │                   │  /console     agent UI+SSE │  │
   │             │  Channel iface    └────────────┬───────────────┘  │
   │  ┌──────────▼─────────────────────────────────▼──────────────┐  │
   │  │             Conversation Engine  (FSM-driven)             │  │
   │  │  session ▸ state router ▸ turn handler ▸ formatter        │  │
   │  │        │                    │                  │          │  │
   │  │  ┌─────▼──────┐   ┌─────────▼────────┐  ┌──────▼───────┐  │  │
   │  │  │ LLM layer  │   │ Escalation policy│  │  Response    │  │  │
   │  │  │ Gemini via │   │ (pure, tested)   │  │  formatter   │  │  │
   │  │  │ OpenAI-compat  └──────────────────┘  └──────────────┘  │  │
   │  │  │ + tool loop│                                           │  │
   │  │  └─────┬──────┘                                           │  │
   │  └────────┼───────────────────────────────────────────────────┘ │
   │     ┌─────┴──────┬────────────┬──────────────┬───────────────┐  │
   │     ▼            ▼            ▼              ▼               ▼  │
   │  Flights     Ranking      Booking +       Email          Escal. │
   │  mock/       (pure fn)    itinerary       nodemailer     service│
   │  amadeus                                  → Gmail SMTP          │
   └──────────────────────────┬──────────────────────────────────────┘
                              │
              ┌───────────────▼────────────────┐        ┌──────────────┐
              │   NEON POSTGRES (free)         │◀───────│ cron-job.org │
              │   wa_auth · sessions · messages│  ping  │  /health     │
              │   bookings · passengers        │  10min │  keeps awake │
              │   escalations · events         │        └──────────────┘
              └────────────────────────────────┘
```

**Local dev is identical** — same code, same Neon database, `CHANNEL=cli` to skip WhatsApp. One code path, so "works locally / breaks deployed" can't happen.

---

## 4. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node 24 + TypeScript**, run via `tsx` (no build step) | Type-safe domain models; `tsx` in `dependencies` so Render runs it directly |
| WhatsApp | **`@whiskeysockets/baileys`** | §2.1 |
| LLM | **`openai` SDK** → Gemini's OpenAI-compatible endpoint (free) | Provider-agnostic: Groq/OpenRouter/Claude = one env var |
| DB | **Neon Postgres** via `pg` | Free, no card, survives Render restarts. Also holds the WhatsApp session |
| Email | **`nodemailer`** + Gmail SMTP (app password) | Sends to *any* recipient — required, since the interviewer gives his own address |
| Web | **Express 5** + one vanilla HTML file + **SSE** | No frontend build |
| Validation | **`zod`** | env, tool args, passenger details |
| Logging | **`pino`** + PII redaction | Render's log viewer is your only prod debugger — make logs good |
| Tests | **`vitest`** | Zero-config with TS |
| Dates | **`luxon`** | Timezone-correct. Never hand-roll |
| QR render | **`qrcode`** | Serves a scannable PNG at `/admin/qr` |

```bash
npm i @whiskeysockets/baileys @hapi/boom pino openai pg express nodemailer zod luxon dotenv qrcode tsx
npm i -D typescript vitest @types/node @types/express @types/pg @types/nodemailer @types/luxon @types/qrcode pino-pretty
```

> `pino` and `tsx` go in **`dependencies`**, not devDependencies — Baileys requires a pino logger at runtime, and Render needs `tsx` to start the app.

### 4.1 `package.json` scripts

```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "cli": "CHANNEL=cli tsx src/index.ts",
    "test": "vitest run",
    "db:push": "tsx scripts/migrate.ts",
    "email:test": "tsx scripts/send-test-email.ts"
  },
  "engines": { "node": ">=20" }
}
```

### 4.2 `.env.example`

```bash
# --- LLM (OpenAI-compatible; swap provider with these 3 vars) ---
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-2.5-flash
LLM_API_KEY=
# Groq backup: LLM_BASE_URL=https://api.groq.com/openai/v1  LLM_MODEL=llama-3.3-70b-versatile

# --- Database (Neon) ---
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

# --- Email ---
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
MAIL_FROM="Waypoint Travel <you@gmail.com>"

# --- Flights ---
FLIGHT_PROVIDER=mock            # mock | amadeus (falls back to mock on any error)
AMADEUS_CLIENT_ID=
AMADEUS_CLIENT_SECRET=

# --- App ---
PORT=3000
PUBLIC_BASE_URL=https://waypoint-xxxx.onrender.com
CHANNEL=whatsapp                # whatsapp | cli
ADMIN_TOKEN=change-me-long-random
OWNER_WHATSAPP=919876543210     # YOUR number — receives escalation alerts (§11.4)
WA_PAIRING_NUMBER=919876543211  # the BOT's number, for pairing-code login
ESCALATION_SLA_MINUTES=10
BUSINESS_HOURS=09:00-22:00
BUSINESS_TZ=Asia/Kolkata
LOG_LEVEL=info
```

### 4.3 Layout

```
waypoint/
├── PLAN.md  README.md  package.json  tsconfig.json  .env.example  .gitignore
├── data/ airports.json  airlines.json  kb.json
├── scripts/ migrate.ts  send-test-email.ts  seed-demo.ts
├── public/ console.html
├── src/
│   ├── index.ts              ← boots Express + channel in ONE process
│   ├── config.ts             ← zod-validated env, fails loudly at startup
│   ├── logger.ts
│   ├── db/ pool.ts  schema.sql  repositories.ts
│   ├── channels/ types.ts  baileys.ts  baileys-auth.ts  cli.ts  memory.ts
│   ├── conversation/ engine.ts  states.ts  session.ts  prompts.ts  tools.ts  formatter.ts
│   ├── flights/ types.ts  provider.ts  mock.ts  amadeus.ts  ranking.ts ★
│   ├── booking/ service.ts  passenger.ts  itinerary.ts
│   ├── email/ service.ts  templates/itinerary.html.ts
│   ├── escalation/ policy.ts ★  brief.ts  service.ts  owner-commands.ts  gaps.ts
│   ├── llm/ client.ts  stub.ts  rules-fallback.ts
│   ├── web/ server.ts  routes/{admin,pay,console,health}.ts
│   └── metrics/analytics.ts
└── tests/ ranking · escalation-policy · passenger-validation · formatter · rules-fallback · conversation.e2e
```

---

## 5. The deployment path (do this EARLY — P1/P2, not at 11pm)

### 5.1 Why Render free works now

| Constraint | How it's handled |
|---|---|
| 512MB RAM | Baileys ≈ 150MB. Comfortable |
| **No persistent disk** | WhatsApp session + all state in **Neon Postgres** (§5.4) |
| **Sleeps after ~15 min idle** | **cron-job.org pings `/health` every 10 min** (§5.5) |
| ~750 instance-hours/month free | One always-on service ≈ 730h. Fits — don't run two |
| Cold start loses the socket | Baileys auto-reconnects from Postgres creds; WhatsApp queues undelivered messages and replays them on reconnect |

*(Free-tier specifics drift — verify against Render's current docs when you sign up. The structural approach holds regardless.)*

**Backups if Render misbehaves:** Koyeb free (doesn't sleep) → Fly.io → Oracle Cloud Always Free ARM (bulletproof, but card + 1–2h setup; only if you have a spare morning, not tonight).

### 5.2 Render service settings

- **Build:** `npm ci` · **Start:** `npm start` · **Instance:** Free · **Health check path:** `/health`
- Paste every `.env` var into Render's Environment tab. Set `PUBLIC_BASE_URL` to the Render URL **after** the first deploy, then redeploy — the payment links in emails depend on it.
- Auto-deploy from `main` is on by default. Keep it: push to deploy.

### 5.3 Logging in — **pairing code, not QR**

Scanning a QR out of a cloud log viewer is miserable. Baileys supports pairing codes: request one for the bot's number, then on that phone open **WhatsApp → Linked devices → Link with phone number instead** and type the 8 characters.

Expose it behind the admin token:

```
GET /admin/pair?token=...&phone=919876543211   → { "pairingCode": "ABCD-EFGH" }
GET /admin/qr?token=...                        → PNG fallback (uses the `qrcode` package)
GET /admin/status?token=...                    → { connected, jid, since, lastError }
```

Implementation notes: only call `sock.requestPairingCode()` **after** the socket emits `connecting` and only when not already registered; set `printQRInTerminal: false`; for the QR route, cache the latest `qr` string from the `connection.update` event and render it on demand.

### 5.4 ★ Postgres-backed Baileys auth (`src/channels/baileys-auth.ts`)

The highest-risk file in the repo. Implement `usePostgresAuthState(pool)` returning `{ state: { creds, keys }, saveCreds }`:

```sql
CREATE TABLE IF NOT EXISTS wa_auth (
  id   TEXT PRIMARY KEY,   -- 'creds'  |  '<keytype>-<keyid>'
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

- Serialise with Baileys' `BufferJSON` replacer/reviver — **credentials contain Buffers and will silently corrupt through plain `JSON.stringify`.** This is the #1 way this breaks.
- `keys.get(type, ids)` → one `SELECT ... WHERE id = ANY($1)`; `keys.set(data)` → batched `INSERT ... ON CONFLICT (id) DO UPDATE`, with `null` values meaning delete.
- On `DisconnectReason.loggedOut`, **wipe the table** and require a fresh pairing — otherwise it reconnect-loops forever.

**Acceptance test, do not skip:** pair it, send a message, then **manually restart the Render service twice**. If it reconnects both times without re-pairing, this is done. If not, nothing else matters.

### 5.5 Keep-alive

cron-job.org → new job → `https://<your>.onrender.com/health`, every **10 minutes**, all day. `/health` returns `200` with `{ ok, wa: 'open'|'connecting'|'closed', uptime }` — so the pinger doubles as uptime monitoring, and you can eyeball whether WhatsApp is actually connected.

### 5.6 Reconnect policy

On `connection.close`: read `(lastDisconnect?.error as Boom)?.output?.statusCode`. Reconnect on everything **except** `DisconnectReason.loggedOut`. Exponential backoff 1s → 2s → 4s … capped at 30s, with jitter. Log every transition — Render's log stream is your only production debugger.

---

## 6. Flights

### 6.1 Types (`src/flights/types.ts`)

```ts
type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
type Preference = 'CHEAPEST' | 'FASTEST' | 'BEST_VALUE' | 'COMFORT';

interface SearchQuery {
  origin: string; destination: string;          // IATA
  departDate: string; returnDate?: string;      // yyyy-mm-dd
  adults: number; children?: number;
  cabin: CabinClass; currency: 'INR';
  nonStopOnly?: boolean; maxPrice?: number;
  departWindow?: { earliest?: string; latest?: string };
}
interface Segment {
  carrierCode: string; carrierName: string; flightNumber: string;
  from: string; to: string; departISO: string; arriveISO: string;
  durationMin: number; aircraft?: string;
}
interface Itin { segments: Segment[]; totalDurationMin: number; stops: number; }
interface FlightOffer {
  id: string; outbound: Itin; inbound?: Itin;
  price: { total: number; perAdult: number; currency: 'INR' };
  cabin: CabinClass; seatsRemaining?: number; refundable: boolean;
  baggage: { cabinKg: number; checkInKg: number };
  provider: 'mock' | 'amadeus';
}
```

### 6.2 Provider interface + fallback

```ts
interface FlightProvider { name: string; search(q: SearchQuery): Promise<FlightOffer[]>; }
```

Factory reads `FLIGHT_PROVIDER`. If `amadeus`, wrap it in a decorator that catches any error or 5s timeout and retries with `MockProvider`, logging `provider_fallback`. **The interviewer's test can never fail because of a third-party API.**

### 6.3 Amadeus (optional, P8 only)
OAuth2 client-credentials → cache token; `GET /v2/shopping/flight-offers`; map to `FlightOffer` in one `mapOffer()` so Amadeus shapes never leak. Test tier has limited routes and stale fares — say so in the README.

### 6.4 Mock provider — must feel real

Seeded by `hash(origin + destination + date)` so **the same query always returns the same flights**. Reproducible demos, deterministic tests, and the interviewer gets consistent results if he searches twice.

12–18 offers per query:
- Route-appropriate carriers — IndiGo / Air India / Vistara / Akasa domestic; Emirates / Qatar / Etihad / Air India / IndiGo international.
- Fare from a distance model: `base = 1800 + distanceKm * 3.2` (haversine from `airports.json`), then × cabin (1 / 1.6 / 3.2 / 5) × days-to-departure (`<3d` 1.55, `<7d` 1.3, `<21d` 1.1, else 1.0) × weekend 1.12 × non-stop 1.18 × red-eye 0.85, ± 8% seeded jitter.
- 0/1/2-stop routings through plausible hubs (DEL, BOM, DXB, DOH, AUH, SIN).
- Layovers 55m–6h; flag <75m as a tight connection.
- Departures spread across early-morning / morning / afternoon / evening / red-eye.

`airports.json`: ~120 airports with IATA, city, aliases, country, lat/lon, tz. `airlines.json`: ~40 carriers with a hand-assigned `qualityScore` 0.6–0.95 (document it as a static on-time proxy, not live data).

---

## 7. ★ Ranking — "best flight", defined (`src/flights/ranking.ts`)

A **pure function**, and the easiest place in the repo to show real engineering. Write its tests as you write it.

### 7.1 Normalise across the candidate set (0 = best, 1 = worst)
`price` · `duration` (total minutes) · `stops` · `departComfort` (05–08 → 0.15, 08–12 → 0, 12–17 → 0.1, 17–21 → 0.2, 21–05 → 0.6) · `layoverQuality` (non-stop 0; <75m → 0.5 risky; >4h → 0.35 dead time; else 0.1) · `carrier` (`1 − qualityScore`).

### 7.2 Weights

| Preference | price | duration | stops | comfort | layover | carrier |
|---|---|---|---|---|---|---|
| `CHEAPEST` | 0.75 | 0.10 | 0.05 | 0.02 | 0.03 | 0.05 |
| `FASTEST` | 0.10 | 0.55 | 0.20 | 0.03 | 0.07 | 0.05 |
| **`BEST_VALUE`** *(default)* | **0.40** | **0.25** | **0.12** | **0.08** | **0.08** | **0.07** |
| `COMFORT` | 0.15 | 0.20 | 0.20 | 0.15 | 0.15 | 0.15 |

`score = Σ wᵢ · normᵢ` — lower wins.

### 7.3 What the user sees
Exactly three labelled picks, deduped (if one offer wins two labels, the second takes the runner-up):
💰 **Cheapest** (min price) · ⚡ **Fastest** (min duration) · ⭐ **Best value** (min `BEST_VALUE` score)

Each carries a **`whyThisOne`** line computed from the numbers, not the LLM — diff the pick against the other two and surface the largest meaningful delta:
> *"₹3,840 cheaper than the fastest, only 20m slower."*
> *"Only non-stop under ₹12k — saves 4h25m vs the cheapest."*

That explainability line is what an interviewer remembers.

### 7.4 Refinement
`refine_search` re-ranks the **cached** offer set with new filters (`nonStopOnly`, `maxPrice`, `departWindow`, `preference`); only re-hit the provider if the cache can't satisfy them. Makes *"anything cheaper?"* and *"morning only"* instant — and saves free-tier quota.

---

## 8. Channel layer

```ts
interface InboundMessage { channelUserId: string; text: string; name?: string; timestamp: number; }
interface Channel {
  name: 'whatsapp' | 'cli' | 'memory';
  start(): Promise<void>;
  onMessage(h: (m: InboundMessage) => Promise<void>): void;
  send(to: string, text: string): Promise<void>;
  sendTyping?(to: string): Promise<void>;
  stop(): Promise<void>;
}
```

Nothing downstream imports Baileys. That's what makes the engine testable via `MemoryChannel` and makes "swap to the official Cloud API" a one-file claim you can defend.

### 8.1 Baileys adapter essentials
- `makeWASocket({ auth: state, logger: pino({level:'warn'}), printQRInTerminal: false, browser: ['Waypoint','Chrome','1.0'], markOnlineOnConnect: false, syncFullHistory: false })`
- `markOnlineOnConnect: false` matters — otherwise the bot hijacks the phone's presence and suppresses the owner's own notifications.
- Handle `messages.upsert` with `type === 'notify'` only. **Ignore** `key.fromMe`, groups (`@g.us`), status broadcasts, and non-text types (reply once: *"I can only read text right now."*).
- Extract text from `conversation` **or** `extendedTextMessage.text` **or** `imageMessage.caption` — people reply-quote constantly and only the second field is populated.
- `sock.sendPresenceUpdate('composing', jid)` before replying + a 600–1200ms delay scaled to reply length. Human-feeling, and it throttles you.
- **Outbound queue:** serialise per-chat with ~800ms gaps. Rapid-fire sending is the #1 ban trigger.
- Split messages >3500 chars on paragraph boundaries.
- Dedupe on `key.id` — reconnects replay messages and you will otherwise answer twice.

### 8.2 Formatting
`*bold*`, `_italic_`, ```` ```mono``` ````. **No buttons or list messages** — unreliable for unofficial clients. Numbered replies: *"Reply **1**, **2** or **3**."* Cap option cards at 3, ≤6 lines each. Stable emoji vocabulary: 💰 ⚡ ⭐ 🛫 🛬 ⏱ 🧳 ✅ ⚠️ 🎫 👤.

---

## 9. Data model (`src/db/schema.sql`, applied by `scripts/migrate.ts`)

```sql
CREATE TABLE IF NOT EXISTS wa_auth (
  id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, channel TEXT, channel_user_id TEXT UNIQUE, display_name TEXT,
  state TEXT NOT NULL, slots JSONB NOT NULL DEFAULT '{}',
  offers JSONB, selected_offer_id TEXT,
  control TEXT NOT NULL DEFAULT 'BOT',            -- BOT | HUMAN
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY, session_id TEXT, wa_msg_id TEXT UNIQUE,
  direction TEXT, author TEXT,                    -- USER | BOT | AGENT
  body TEXT, confidence REAL, intent TEXT, created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS bookings (
  ref TEXT PRIMARY KEY, session_id TEXT, offer JSONB, total INT, currency TEXT,
  status TEXT, payment_link TEXT, email_to TEXT,
  emailed_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS passengers (
  id BIGSERIAL PRIMARY KEY, booking_ref TEXT, seq INT, full_name TEXT, dob DATE,
  gender TEXT, email TEXT, phone TEXT, passport_no TEXT, passport_expiry DATE, nationality TEXT);

CREATE TABLE IF NOT EXISTS escalations (
  ticket TEXT PRIMARY KEY, session_id TEXT, reason TEXT, confidence REAL, brief JSONB,
  status TEXT, claimed_by TEXT, resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), claimed_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, session_id TEXT, type TEXT, payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now());
```

`wa_msg_id UNIQUE` is the idempotency guard for replayed messages.

---

## 10. Conversation design

### 10.1 States
```
GREETING → COLLECTING_TRIP → SEARCHING → PRESENTING_OPTIONS → AWAITING_SELECTION
  → COLLECTING_PASSENGER (× pax) → CONFIRMING → ISSUING → COMPLETED
any state ──policy──▶ ESCALATED ──agent──▶ HUMAN_CONTROL ──▶ resume
```
Each state declares allowed tools, required slots, its system-prompt fragment, and legal transitions. The LLM proposes; `engine.ts` validates against the state and executes. A forbidden proposal → ignore, re-prompt once → escalate.

### 10.2 Trip slots
`origin, destination, departDate, returnDate?, tripType, adults, children, cabin, preference, budgetMax?, nonStopOnly?`

- **Ask at most 2 missing slots per message.** Never interrogate.
- City → IATA via `airports.json` aliases ("bangalore"/"bengaluru"/"blr" → BLR). Ambiguous ("London") → one disambiguation question.
- Relative dates ("next friday", "27th", "tomorrow") resolved by **luxon in `Asia/Kolkata`**, never by the LLM. Past date → correct and confirm.
- Silent defaults: `adults=1`, `cabin=ECONOMY`, `preference=BEST_VALUE`, `tripType=ONE_WAY` unless a return is mentioned.

### 10.3 Passenger slots
`fullName` (as on ID), `dateOfBirth`, `gender`, `email`, `phone`; plus passport number/expiry/nationality **only on international routes**. Zod-validated; DOB sanity (0–120y, before travel). One passenger at a time — *"Passenger 1 of 2 — full name as on the ID?"* — but accept multiple fields if volunteered.

### 10.4 Tools exposed to the model
`search_flights` · `refine_search` · `select_flight` · `save_passenger` · `confirm_booking` · `answer_faq` · `escalate_to_human`. Every tool's args are zod-validated before execution; a failure returns a tool error the model may recover from **once**, then escalates.

### 10.5 Free-tier resilience (`src/llm/rules-fallback.ts`)
Gemini's free tier has per-minute and per-day caps, and the interviewer may test in bursts. Guard rails:
- Retry on 429/5xx with backoff (3 attempts), then **fall back to rules-only extraction**: regex + luxon for dates, `airports.json` for cities, digits for pax. Degraded but alive.
- Cache offers per session so refinements cost zero API calls.
- Never let an LLM failure surface as silence — worst case, escalate with `PROVIDER_FAILURE`.

### 10.6 Anti-blabber rules (put verbatim in the system prompt)
- ≤900 characters per message, except itineraries and option cards.
- Never repeat what the user already told you. Never apologise twice for the same thing.
- **Never state a price, flight number, time, or policy that isn't in a tool result or the KB.**
- If you don't know: one sentence saying so, then call `escalate_to_human`. Never speculate.

Plus a **programmatic post-check**: if an outbound message contains a `₹` amount or a flight number absent from the session's offer cache → suppress, log `hallucination_blocked`, escalate. Belt and braces.

### 10.7 Target transcript (this is your demo script)
```
User: hey need flights
Bot:  Hi! I'm Waypoint ✈️ I'll find you the best fare in under a minute.
      Where from, and where to?

User: bangalore to dubai, next friday, 2 adults
Bot:  Got it — *BLR → DXB*, Fri 26 Sep, 2 adults, economy.
      Searching 40+ fares… ⏱

Bot:  Here are the three that matter 👇

      *1.* 💰 *Cheapest* — ₹28,940 for 2
      IndiGo 6E-1471 · 🛫 04:15 → 🛬 07:05 · 4h 20m · non-stop
      _₹6,100 less than the fastest — but it's a 4am departure._

      *2.* ⚡ *Fastest* — ₹35,040 for 2
      Emirates EK-569 · 🛫 09:40 → 🛬 12:15 · 4h 05m · non-stop
      _Quickest door-to-door, best baggage (30kg)._

      *3.* ⭐ *Best value* — ₹31,200 for 2
      Air India AI-905 · 🛫 10:20 → 🛬 13:15 · 4h 25m · non-stop
      _Only 20m slower than the fastest, ₹3,840 cheaper. 🧳 25kg._

      Reply *1*, *2* or *3* — or tell me what to change
      (e.g. "evening flights", "under 30k").

User: 3
Bot:  ⭐ Locked: *AI-905, 26 Sep, 10:20 BLR → 13:15 DXB* · ₹31,200.
      Passenger 1 of 2 — full name exactly as on the passport?
…
Bot:  ✅ *Itinerary WP-8K2M confirmed*   [itinerary card]
      📧 Sent to interviewer@example.com with your payment link.
      Hold expires in 30 minutes.
```

---

## 11. ★ Escalation — "Warm Transfer"

> README line: **"Escalation isn't a failure path. It's a product surface — where the bot's honesty, the agent's speed, and the team's learning loop all get tested."**

### 11.1 Layer 0 — never bluff
Tool-only facts (§10.6). Every turn emits `TurnDecision { intent, confidence, slots, action, escalate? }`. No flight is ever actually "booked" — we issue a quote + payment link, and the bot says so.

### 11.2 Layer 1 — self-repair first
Max **1** clarifying question per slot; max **2** consecutive low-confidence turns. Adjacent questions (baggage, visa, web check-in, cancellation, seats) answered from `data/kb.json` — 10–12 curated entries with a `source` field. **No KB match → escalate, never improvise.**

### 11.3 Layer 2 — triggers (`policy.ts`, pure + heavily tested)

| Reason | Fires when |
|---|---|
| `USER_REQUESTED_HUMAN` | "agent", "human", "talk to someone", "customer care" |
| `LOW_CONFIDENCE_REPEATED` | 2 consecutive turns under 0.55 confidence |
| `OUT_OF_SCOPE` | Intent outside flights/booking and not in the KB |
| `KNOWLEDGE_GAP` | Adjacent question, no KB match |
| `PROVIDER_FAILURE` | Search / LLM / email failed after retries |
| `POLICY_SENSITIVE` | Refunds, medical, unaccompanied minors, visa eligibility, groups >9 |
| `NEGATIVE_SENTIMENT` | Frustration markers, or 2+ corrections within 3 turns |
| `HIGH_VALUE` | Quote over ₹1,50,000 |

### 11.4 ★★ The v2 centrepiece — **agent control over WhatsApp**

The interviewer will test at a time you don't control. You will not be sitting at the console. So the bot **hands off to you on your own phone.**

When an escalation fires:

1. **Ticket** `WP-4F2A`. Session → `HUMAN_CONTROL`. Bot mutes.
2. **The user is told the truth, once, in ≤3 lines** — no apology spiral:
   > ⚠️ *I've hit something I shouldn't guess at.*
   > Handing you to a human specialist — ticket `WP-4F2A`. Someone will reply here within ~10 minutes.
   > Meanwhile I can keep noting your trip details so they don't ask twice — want me to?

   *(Outside `BUSINESS_HOURS`: state the exact next-available time and offer a callback slot. Never promise an SLA you can't hit.)*
3. **You get a WhatsApp message on `OWNER_WHATSAPP`** — from the bot, instantly, wherever you are:
   ```
   🔔 *Escalation WP-4F2A*  ·  reason: KNOWLEDGE_GAP
   From: +91 98••• (Rahul)  ·  waiting 0m

   *Situation:* User asked whether his 11-month-old needs a
   separate seat on BLR→DXB. Not in KB; bot refused to guess.
   *Trip:* BLR→DXB · 26 Sep · 2 adults + 1 infant · economy
   *Last msg:* "so do i need to buy a seat for the baby or not"

   *Suggested reply:* "Infants under 2 travel on a parent's lap…"

   ↳ /take WP-4F2A          take over
   ↳ /reply WP-4F2A <text>  send as agent
   ↳ /bot WP-4F2A           hand back
   ↳ /tickets               list open
   ```
4. **You reply from your phone.** `/reply WP-4F2A Infants under 2 travel free on a parent's lap…` → relayed to the user prefixed `👤 *Priya (Waypoint)*:`. The user can't tell the transport changed.
5. **`/bot WP-4F2A`** hands back; the bot re-reads the human turns as context and continues: *"Thanks for holding — picking up from what Priya sorted out…"*
6. **Auto-recovery if you're asleep:** after `ESCALATION_SLA_MINUTES` with no claim, the bot messages the user again — honest, specific, still useful: *"Our specialist is still tied up. I've emailed your details to the team and they'll reply here by 09:30. Meanwhile I can still search flights for you — want to keep going?"* — and, where safe, resumes the parts it *can* do.

**Why this is the right design, and say this in the interview:** a handoff that depends on someone watching a dashboard doesn't work at 11pm. Routing the human into the channel they already have open makes escalation operationally real. `owner-commands.ts` is ~120 lines and it's the most product-minded thing in the repo.

### 11.5 Handoff Brief (`brief.ts`)
One LLM call, strict JSON, generated at escalation time: 50-word situation summary · extracted entities · last 10 messages · what the bot tried · the exact blocker · confidence trace · **a suggested first reply**. Rendered compactly for WhatsApp (§11.4) and fully in the console. If the LLM call fails, fall back to a template-built brief — **escalation must never depend on the LLM working.**

### 11.6 Agent console (`public/console.html`, one file, SSE)
Left: live escalation queue (ticket, reason chip, wait timer reddening past SLA). Centre: transcript + brief card + reply box + *Take over* / *Return to bot*. Right: metrics (§12) + knowledge-gap register. Auth via `?token=` matched to `ADMIN_TOKEN`; note in the README that real auth is the next step.

### 11.7 Learning loop (`gaps.ts`)
Every resolved escalation writes `{ reason, userUtterance, resolution, ts }` to the `events` table; the console shows **top knowledge gaps**, ranked by frequency. That's the JD's "iterate based on evidence", made concrete — and the natural answer to *"what would you build next?"*

---

## 12. Metrics (`metrics/analytics.ts`, plain SQL)

Containment rate (% sessions reaching `COMPLETED` with no escalation) · median time-to-first-quote · median turns to a complete `SearchQuery` · escalation mix by reason · drop-off funnel by state · top knowledge gaps. ~40 lines of SQL that makes the submission read like a product.

---

## 13. Booking, itinerary, email, payment

- **Ref:** `WP-` + 6 base36 chars, uniqueness-checked.
- **WhatsApp itinerary card:** ref, segment lines, times with airport codes, duration, passengers, fare breakdown, baggage, and *"⚠️ Not ticketed until payment — link sent to <email>."*
- **Email** (nodemailer → Gmail SMTP): subject `Your Waypoint itinerary WP-8K2M — BLR → DXB, 26 Sep`; table-based HTML, inline CSS, ≤600px, **plus a plain-text part**; segments, passengers, fare breakdown, a big **"Complete payment — ₹31,200"** button, 30-min hold notice, baggage/cancellation lines, support footer.
- **Payment link** → `${PUBLIC_BASE_URL}/pay/WP-8K2M`, served by Express. Clearly labelled as a demo, shows the booking summary, and has a **"Simulate successful payment"** button that flips status to `PAID` and **fires a WhatsApp confirmation to the user**.
  > That loop — interviewer opens the email *on his phone*, taps the link, taps pay, and a WhatsApp confirmation lands seconds later — is the single best moment in this build. Make sure it works.
- Retry sends twice; on final failure tell the user, log, and raise `PROVIDER_FAILURE`. **Never claim an email was sent when it wasn't.**
- **If Render blocks SMTP or Gmail lands in spam:** switch to **Brevo** free SMTP relay (300/day, sends to any address, no domain verification). Keep the credentials ready as a fallback in `.env`.
- Run `npm run email:test` the moment SMTP creds exist — not at 11pm.

---

## 14. Execution timeline — **Sat 19 Sep, 13:00 → 23:45 IST**

Deployment moved to the front. The nightmare scenario is a finished bot that won't deploy at 11pm; so we deploy an *echo bot* by 15:30 and every feature after that ships onto a known-good pipeline. Commit at every phase — visible incremental history is itself a signal.

| Phase | Clock | Deliverable | Done when |
|---|---|---|---|
| **P0 — Scaffold + DB** | 13:00–13:40 | git + repo pushed, TS, zod config, pino, Neon pool, `schema.sql` + `migrate.ts`, `Channel` iface, `CliChannel`, vitest | `npm run db:push` creates tables in Neon; `npm run cli` echoes |
| **P1 — ★ Baileys + Postgres auth** | 13:40–14:40 | `baileys-auth.ts`, `baileys.ts`, reconnect, dedupe, outbound queue, `/health` `/admin/pair` `/admin/qr` | Bot echoes on real WhatsApp **locally** |
| **P2 — ★ DEPLOY** | 14:40–15:30 | Render service live, env set, `PUBLIC_BASE_URL` set + redeployed, cron-job.org pinger, pair from the deployed instance | **Echo bot replies on WhatsApp from Render — and survives 2 manual restarts without re-pairing** |
| **P3 — Flights + ranking** | 15:30–16:45 | `airports.json`, `airlines.json`, `MockProvider`, **`ranking.ts`** + 8–10 tests | Tests green; script prints 3 labelled picks for BLR→DXB |
| **P4 — Conversation engine** | 16:45–18:30 | FSM, session store, prompts, tool loop, `llm/stub.ts`, rules fallback, formatter | Deployed bot returns real option cards on WhatsApp |
| *Dinner* | 18:30–19:00 | Eat. The last 5 hours need a working brain | — |
| **P5 — Booking + email + payment** | 19:00–20:15 | selection, passenger loop + zod, itinerary renderers, nodemailer, `/pay/:ref` + simulate → WhatsApp confirm | **Email lands in a real inbox; tapping the link on your phone triggers a WhatsApp confirmation** |
| **P6 — ★ Escalation** | 20:15–21:45 | `policy.ts` + tests, `brief.ts`, ticket lifecycle, **`owner-commands.ts`**, console + SSE, SLA auto-recovery | Say "talk to a human" → alert hits **your** phone → `/reply` reaches the user → `/bot` hands back |
| **P7 — Harden + verify** | 21:45–22:30 | retries, circuit breaker, PII redaction, e2e test, metrics, final redeploy, **full cold-path test from a third phone** | All tests green; a phone that has never messaged the bot completes the whole flow |
| **P8 — Ship** | 22:30–23:45 | README + architecture + deployment notes, `.env.example`, **demo video**, submission note. Amadeus only if time remains | Repo + video + live number ready to send |

### Hard checkpoints — check the clock and cut without negotiating

- **15:30 — if the echo bot is not replying from Render, stop building features.** Fix deployment or fall back to Koyeb. Everything downstream is worthless without this.
- **18:30 — if the bot isn't returning option cards, drop passenger collection to a single passenger** and go straight to email.
- **20:15 — if email hasn't reached a real inbox, that's your P6.** Email is the assignment's explicitly stated main target; it outranks escalation.
- **21:45 — stop all features.** Whatever escalation exists is what ships.
- **22:30 — hard stop, no exceptions.** README + video. A 90% build with a great README and video beats a 100% build with neither.
- **23:30 — push and send**, even if something is unfinished. Ship, then name the gap honestly.

---

## 15. Cut-list (in this order)

1. Amadeus → mock only, documented honestly
2. Agent web console → keep **WhatsApp owner commands** (§11.4), drop the UI
3. Metrics pane → drop
4. Round-trip → one-way only
5. Multi-passenger → single passenger
6. Knowledge-gap register → keep the event logging, drop the view

**Never cut:** the deployment, the email actually sending, the ranking explanation lines, the escalation honesty + owner alert, the tests on `ranking.ts` and `policy.ts`.

---

## 16. Pre-submission verification (do this at 22:30, from a phone that has never talked to the bot)

- [ ] Message the number cold → greeting arrives in <5s
- [ ] Full happy path → 3 ranked options → selection → passenger details → itinerary
- [ ] Email arrives (**check spam**); payment link opens on mobile; simulate-pay → WhatsApp confirmation arrives
- [ ] Say *"I want to talk to a human"* → user gets the honest handoff; **your** phone gets the alert; `/reply` reaches the user; `/bot` hands back
- [ ] Ask something absurd ("book me a submarine") → graceful scope refusal, no hallucination
- [ ] **Restart the Render service mid-conversation** → bot resumes without re-pairing and without losing session state
- [ ] Send 5 messages rapid-fire → no duplicate replies, no crash
- [ ] `/health` returns `wa: "open"`; cron-job.org shows green pings
- [ ] `npm test` green on a clean clone; `.env` not committed

---

## 17. Risks

| Risk | Mitigation |
|---|---|
| **Postgres auth state corrupts → constant re-pairing** | Use Baileys' `BufferJSON` replacer/reviver. Prove it with 2 restarts in P2. Highest-risk item in the build |
| Render sleeps / cold start | cron-job.org every 10 min; auto-reconnect; WhatsApp replays queued messages |
| Render free hours exhausted | Run exactly one service. Don't spin up a second |
| Number banned mid-evaluation | Spare number; 800ms outbound throttle; `markOnlineOnConnect:false`; never bulk-send. Keep a second spare SIM in reserve |
| Gemini rate limit during the interviewer's test | Backoff → rules-only fallback → escalate. Offers cached per session. Groq key hot-swappable in Render env |
| Gmail SMTP blocked / spam-foldered | Test in P5. Brevo free SMTP relay as the documented fallback |
| Interviewer tests at 3am and escalates | SLA auto-recovery (§11.4 step 6) — the bot stays honest and useful with no human present |
| Deployment eats the whole evening | That's why it's P2. If Render fails by 15:30, switch to Koyeb immediately rather than debugging |

---

## 18. README structure (§P8 — it is graded)

1. What it is + the **live WhatsApp number** and a chat screenshot
2. **Demo video** link, at the top
3. Quickstart: clone → `.env` → `npm run db:push` → `npm start` → pair
4. Architecture diagram (§3)
5. **Design decisions:** why Baileys over `whatsapp-web.js` (and what production would use) · why the FSM owns the flow · how "best flight" is computed (§7 table) · why escalation routes to WhatsApp, not a dashboard · provider-agnostic LLM layer, built entirely on free tiers · what's mocked and why
6. Testing: what's covered, how to run
7. **Known limitations, stated plainly** — unofficial client isn't ToS-safe at scale, mock fares, no real payments, shared-token console auth

---

## 19. Demo video script (3–4 min — record it, don't wing it)

Record at 22:30 per §14. Two devices on screen where possible: the interviewer-facing phone, and your own phone for the escalation beat.

| Time | Beat |
|---|---|
| 0:00 | 15s — what it is, one sentence. Show the **live number** and say it's deployed, not localhost |
| 0:20 | Happy path on a real phone: free-text request → 3 ranked options. **Read the "why this one" line out loud** — that's the differentiator, don't let it scroll past |
| 1:00 | Say *"anything cheaper in the morning?"* → instant re-rank. 10s, shows it's a conversation, not a form |
| 1:20 | Pick one → passenger details → itinerary card |
| 1:50 | Cut to inbox on the phone: email arrives → tap the payment link → tap simulate → **WhatsApp confirmation lands live on the same screen.** Best 15 seconds in the video |
| 2:15 | **Escalation:** ask something out of scope → bot refuses to guess, issues a ticket → **cut to your own phone receiving the alert + brief** → `/reply` from your phone → it arrives in the user's chat → `/bot` hands back. Narrate: *"no dashboard, no one watching a screen"* |
| 3:00 | 20s — restart the Render service on camera, show the bot reconnect and the conversation continue. Proves the Postgres session design |
| 3:20 | 20s — architecture one-liner, `npm test` green, one sentence on what you'd build next |

Two rules: **no dead air waiting for API calls** (cut them), and **say the number out loud at the start and end** so the interviewer knows he can go test it himself immediately.

---

## 20. Interview talking points

- *"The LLM never decides anything — it extracts and proposes, the state machine decides and executes. That's why the conversation layer has unit tests and why it structurally cannot invent a fare."*
- *"'Best flight' isn't a sort, it's a weighted score across price, duration, stops, layover quality and departure comfort — and the bot explains the tradeoff in one line. Users don't want ten options, they want to know why this one."*
- *"Escalation routes to WhatsApp, not a dashboard. A handoff that assumes someone is watching a screen doesn't work at 11pm — so the bot messages the on-call human on the channel they already have open, and they can take over, reply and hand back from their phone."*
- *"It's deployed on strictly free infrastructure, and that shaped real engineering: Baileys instead of a headless Chromium to fit in 512MB, and the WhatsApp session in Postgres because the free tier has no disk — so it survives every restart."*
- Limitations, unprompted, before being asked.

---

## 21. Next session: start here

```
Read PLAN.md (v2, deploy-first). Execute P0 and P1 (§14): git repo, TypeScript,
zod config, pino, Neon pool + schema/migrate, the Channel interface, CliChannel,
then the Baileys adapter with the Postgres-backed auth state from §5.4 —
BufferJSON serialisation, reconnect policy, message dedupe, outbound queue,
and the /health, /admin/pair, /admin/qr routes.

Stop when the bot echoes on real WhatsApp locally. Then do P2: deploy to Render
and prove it survives two restarts without re-pairing. Do not start P3 until
that passes.
```
