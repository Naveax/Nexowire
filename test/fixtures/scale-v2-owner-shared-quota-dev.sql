-- DEV/STAGING, owner-controlled durable SQLite ONLY.
-- Do not deploy on a customer PC or as a production Cloudflare migration.
CREATE TABLE proposed_owner_quota_accounts (
  account_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK(tier IN ('free','plus','pro','custom')),
  custom_daily_limit INTEGER,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  session_generation INTEGER NOT NULL CHECK(session_generation>=0)
);
CREATE TABLE proposed_owner_quota_devices (
  device_id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('safe','full'))
);
CREATE TABLE proposed_owner_quota_account_clock (
  account_id TEXT PRIMARY KEY,
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE proposed_owner_quota_daily (
  account_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
  PRIMARY KEY(account_id,day_utc)
);
CREATE TABLE proposed_owner_quota_invocations (
  account_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tool_fingerprint TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_id,invocation_id)
);
