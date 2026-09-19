-- Waypoint schema. Idempotent: safe to run on every boot / deploy.

CREATE TABLE IF NOT EXISTS wa_auth (
  id         TEXT PRIMARY KEY,           -- 'creds' | '<keytype>-<keyid>'
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL,
  channel_user_id   TEXT UNIQUE NOT NULL,
  display_name      TEXT,
  state             TEXT NOT NULL,
  slots             JSONB NOT NULL DEFAULT '{}',
  offers            JSONB,
  selected_offer_id TEXT,
  control           TEXT NOT NULL DEFAULT 'BOT',   -- BOT | HUMAN
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  wa_msg_id  TEXT UNIQUE,                -- idempotency guard for replayed messages
  direction  TEXT,
  author     TEXT,                       -- USER | BOT | AGENT
  body       TEXT,
  confidence REAL,
  intent     TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id DESC);

CREATE TABLE IF NOT EXISTS bookings (
  ref          TEXT PRIMARY KEY,
  session_id   TEXT,
  offer        JSONB,
  total        INT,
  currency     TEXT,
  status       TEXT,
  payment_link TEXT,
  email_to     TEXT,
  emailed_at   TIMESTAMPTZ,
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passengers (
  id              BIGSERIAL PRIMARY KEY,
  booking_ref     TEXT,
  seq             INT,
  full_name       TEXT,
  dob             DATE,
  gender          TEXT,
  email           TEXT,
  phone           TEXT,
  passport_no     TEXT,
  passport_expiry DATE,
  nationality     TEXT
);

CREATE TABLE IF NOT EXISTS escalations (
  ticket          TEXT PRIMARY KEY,
  session_id      TEXT,
  reason          TEXT,
  confidence      REAL,
  brief           JSONB,
  status          TEXT,
  claimed_by      TEXT,
  resolution      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  sla_notified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS escalations_status_idx ON escalations (status, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  type       TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, created_at DESC);
