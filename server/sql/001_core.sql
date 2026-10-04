-- =============================================================================
-- Tracalorie core schema: identity, tracking data, security infrastructure.
--
-- Applied by `npm run migrate`. Every statement is idempotent (IF NOT EXISTS /
-- guarded DO blocks) so the migration is safe to re-run on every deploy.
--
-- Security model
-- --------------
-- * PII is stored as AES-256-GCM ciphertext (`*_enc` columns). The plaintext
--   never reaches disk. Uniqueness and lookup on encrypted columns are served
--   by HMAC-SHA-256 blind indexes (`*_bidx` columns), which are deterministic
--   but non-reversible.
-- * Refresh tokens are stored only as SHA-256 fingerprints.
-- * Security events land in an append-only hash-chained audit table.
--
-- Do not INSERT into schema_migrations here; migrate.js owns that table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- pgcrypto gives us gen_random_uuid() on older Postgres (9.x) where it is not
-- built in. Harmless to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,

  -- Login identifier. Case-insensitive uniqueness is enforced with a citext-free
  -- approach: the app lowercases before insert and a unique index guards drift.
  username          TEXT NOT NULL,
  username_bidx     TEXT NOT NULL,

  -- Optional email: ciphertext + blind index for uniqueness/lookup.
  email_enc         TEXT,
  email_bidx        TEXT,

  -- Optional display name: ciphertext only, never used for lookup.
  display_name_enc  TEXT,

  password_hash     TEXT NOT NULL,

  -- Progressive lockout state, updated on every failed authentication.
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_failed_login_at TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  last_login_ip       INET,

  -- Credential lifecycle. `password_changed_at` lets us reject access tokens
  -- minted before a password change.
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Bumped to invalidate outstanding access tokens (e.g. on "log out
  -- everywhere"). Access tokens carry this value; a mismatch means 401.
  token_epoch       INTEGER NOT NULL DEFAULT 1,

  calorie_limit     INTEGER NOT NULL DEFAULT 2000,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  units             TEXT NOT NULL DEFAULT 'metric',

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'locked', 'pending_deletion', 'deleted')),

  -- Right-to-be-forgotten: user-initiated deletion sets this and a background
  -- job hard-deletes after the retention window. Keeps the audit chain intact
  -- (actor_id is nullable and rows are not cascaded) while removing PII.
  deletion_requested_at TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_username_bidx_key UNIQUE (username_bidx)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_bidx
  ON users (email_bidx) WHERE email_bidx IS NOT NULL;

-- Case-insensitive login lookup. username is already normalised to lowercase by
-- the application; this index catches any drift before it creates duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users (lower(username));

-- Bcrypt digests are ~60 chars; the check is free and documents intent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_hash_length;
ALTER TABLE users ADD CONSTRAINT users_password_hash_length
  CHECK (char_length(password_hash) BETWEEN 40 AND 120);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_calorie_limit_range;
ALTER TABLE users ADD CONSTRAINT users_calorie_limit_range
  CHECK (calorie_limit BETWEEN 500 AND 20000);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_units_valid;
ALTER TABLE users ADD CONSTRAINT users_units_valid
  CHECK (units IN ('metric', 'imperial'));

-- -----------------------------------------------------------------------------
-- user_sessions
-- -----------------------------------------------------------------------------
-- One row per issued refresh token. Rotating a refresh token creates a new row
-- in the same `family_id` and revokes the old one, so a single stolen token
-- cannot be replayed without tripping reuse detection.
CREATE TABLE IF NOT EXISTS user_sessions (
  id                SERIAL PRIMARY KEY,
  session_uuid      UUID NOT NULL DEFAULT gen_random_uuid(),

  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Groups a rotation lineage. Reuse of any member revokes the whole family.
  family_id         UUID NOT NULL DEFAULT gen_random_uuid(),

  -- SHA-256 of the refresh token. The token itself is never persisted.
  token_hash        TEXT NOT NULL,

  -- Short-lived JWT access token metadata.
  access_jti        UUID NOT NULL DEFAULT gen_random_uuid(),

  ip_address        INET,
  user_agent        TEXT,

  -- Device fingerprint, coarse and non-identifying: helps a user recognise a
  -- session in the "active sessions" list without storing anything that tracks
  -- them across browsers.
  device_label      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT
);

-- Token lookup happens on every authenticated request: must be a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON user_sessions (token_hash);

-- "Active sessions" listing and revoke-all are both scoped by user.
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON user_sessions (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- Reuse detection pivots on family, so index it.
CREATE INDEX IF NOT EXISTS idx_sessions_family
  ON user_sessions (family_id);

ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS sessions_revoked_reason_valid;
ALTER TABLE user_sessions ADD CONSTRAINT sessions_revoked_reason_valid
  CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'rotated', 'logout', 'logout_all', 'password_change',
    'reuse_detected', 'expired', 'admin', 'account_deleted'
  ));

-- -----------------------------------------------------------------------------
-- password_history
-- -----------------------------------------------------------------------------
-- Blocks trivial reuse: a new password must differ from the last N. Passwords
-- are stored only as bcrypt digests, so this table cannot be used as a
-- credential store even if it leaks.
CREATE TABLE IF NOT EXISTS password_history (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_history_user_created
  ON password_history (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- login_attempts
-- -----------------------------------------------------------------------------
-- Fine-grained brute-force telemetry. Distinct from `users.locked_until`:
-- this records every attempt (including for unknown usernames) so that
-- credential-stuffing across accounts is visible.
CREATE TABLE IF NOT EXISTS login_attempts (
  id           BIGSERIAL PRIMARY KEY,
  identifier   TEXT NOT NULL,
  ip_address   INET,
  user_agent   TEXT,
  successful   BOOLEAN NOT NULL DEFAULT false,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier
  ON login_attempts (identifier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip
  ON login_attempts (ip_address, created_at DESC);

-- -----------------------------------------------------------------------------
-- items
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('meal', 'workout')),
  name        TEXT NOT NULL,
  calories    INTEGER NOT NULL,
  -- Local calendar day the entry belongs to, so day-bucketed statistics do not
  -- shift with the server's timezone. Set by the application from the client's
  -- timezone-aware value, defaulting to the UTC date.
  entry_date  DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT items_calories_range CHECK (calories BETWEEN -20000 AND 20000),
  CONSTRAINT items_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_items_user_created ON items (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_user_date ON items (user_id, entry_date);

-- -----------------------------------------------------------------------------
-- foods (saved library)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS foods (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('meal', 'workout')),
  name        TEXT NOT NULL,
  calories    INTEGER NOT NULL,
  times_used  INTEGER NOT NULL DEFAULT 1,
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, type, name),
  CONSTRAINT foods_calories_range CHECK (calories BETWEEN -20000 AND 20000),
  CONSTRAINT foods_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);

-- -----------------------------------------------------------------------------
-- security_audit (append-only, hash-chained)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_audit (
  id            BIGSERIAL PRIMARY KEY,
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  outcome       TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  ip_address    INET,
  user_agent    TEXT,
  request_id    TEXT,
  session_id    UUID,
  details       JSONB,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Verification reads one actor's chain in id order.
CREATE INDEX IF NOT EXISTS idx_audit_actor_id ON security_audit (actor_id, id);
-- The dashboard filters by recency and action.
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON security_audit (occurred_at DESC);
-- Pre-auth events chain under a NULL actor.
CREATE INDEX IF NOT EXISTS idx_audit_system ON security_audit (id) WHERE actor_id IS NULL;

-- -----------------------------------------------------------------------------
-- security_findings
-- -----------------------------------------------------------------------------
-- Detected anomalies surfaced to the user in the security panel: a login from a
-- new device, a burst of failed attempts, a password reset. Distinct from
-- security_audit, which is the raw event stream.
CREATE TABLE IF NOT EXISTS security_findings (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high')),
  message      TEXT NOT NULL,
  metadata     JSONB,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_user ON security_findings (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- data_exports
-- -----------------------------------------------------------------------------
-- Ledger of GDPR/CCPA data-export requests. Points at the object-store location
-- when an export was uploaded, or records an inline delivery.
CREATE TABLE IF NOT EXISTS data_exports (
  id            SERIAL PRIMARY KEY,
  export_uuid   UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format        TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
  storage       TEXT NOT NULL DEFAULT 'inline' CHECK (storage IN ('inline', 'gcs')),
  location      TEXT,
  byte_size     BIGINT,
  checksum      TEXT,
  expires_at    TIMESTAMPTZ,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exports_user ON data_exports (user_id, requested_at DESC);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_items_updated_at ON items;
CREATE TRIGGER trg_items_updated_at BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Append-only enforcement for security_audit
-- -----------------------------------------------------------------------------
-- Defence in depth: even a compromised application role with UPDATE/DELETE on
-- the table cannot silently rewrite history. Chains are still verified by the
-- application, because a superuser can always drop a trigger.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'security_audit is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON security_audit;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON security_audit
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- schema_migrations is created and written exclusively by migrate.js, which
-- records a checksum per applied file. A migration must never touch that table
-- itself: an earlier version did, and its INSERT raced the runner's, leaving
-- every checksum NULL so drift detection silently never worked.
-- -----------------------------------------------------------------------------
