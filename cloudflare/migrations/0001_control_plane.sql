PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free', 'plus', 'pro', 'custom')),
  custom_plan_json TEXT,
  admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_owner
  ON devices(owner_account_id);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON devices(last_seen_at);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pairings_owner
  ON pairings(owner_account_id);

CREATE TABLE IF NOT EXISTS usage_periods (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  used_credits INTEGER NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  prepaid_credits INTEGER NOT NULL DEFAULT 0 CHECK (prepaid_credits >= 0),
  PRIMARY KEY (account_id, period_key)
);

CREATE TABLE IF NOT EXISTS usage_events (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  billing_mode TEXT NOT NULL CHECK (
    billing_mode IN ('free', 'subscription', 'prepaid-metered')
  ),
  monthly_credits INTEGER,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  charged_at TEXT NOT NULL,
  PRIMARY KEY (account_id, period_key, event_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_charged_at
  ON usage_events(charged_at);

DROP TRIGGER IF EXISTS trg_usage_event_apply;

CREATE TRIGGER trg_usage_event_apply
BEFORE INSERT ON usage_events
BEGIN
  INSERT INTO usage_periods (
    account_id,
    period_key,
    period_start,
    period_end,
    used_credits,
    prepaid_credits
  )
  VALUES (
    NEW.account_id,
    NEW.period_key,
    NEW.period_start,
    NEW.period_end,
    0,
    0
  )
  ON CONFLICT(account_id, period_key) DO NOTHING;

  SELECT CASE
    WHEN NEW.billing_mode = 'prepaid-metered'
      AND (
        SELECT prepaid_credits
        FROM usage_periods
        WHERE account_id = NEW.account_id
          AND period_key = NEW.period_key
      ) < NEW.credits
    THEN RAISE(ABORT, 'quota_exhausted')
    WHEN NEW.billing_mode <> 'prepaid-metered'
      AND NEW.monthly_credits IS NOT NULL
      AND (
        SELECT used_credits
        FROM usage_periods
        WHERE account_id = NEW.account_id
          AND period_key = NEW.period_key
      ) + NEW.credits > NEW.monthly_credits
    THEN RAISE(ABORT, 'quota_exhausted')
  END;

  UPDATE usage_periods
  SET
    used_credits = CASE
      WHEN NEW.billing_mode = 'prepaid-metered'
        THEN used_credits
      ELSE used_credits + NEW.credits
    END,
    prepaid_credits = CASE
      WHEN NEW.billing_mode = 'prepaid-metered'
        THEN prepaid_credits - NEW.credits
      ELSE prepaid_credits
    END
  WHERE account_id = NEW.account_id
    AND period_key = NEW.period_key;
END;
