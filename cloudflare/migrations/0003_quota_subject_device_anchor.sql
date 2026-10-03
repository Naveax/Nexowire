PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quota_subjects (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('free-cluster', 'subscription', 'prepaid')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN quota_subject_id TEXT;

INSERT OR IGNORE INTO quota_subjects (
  id,
  kind,
  created_at,
  updated_at
)
SELECT
  'quota_' || id,
  CASE
    WHEN plan_id = 'free' THEN 'free-cluster'
    WHEN plan_id = 'custom' THEN 'prepaid'
    ELSE 'subscription'
  END,
  created_at,
  updated_at
FROM accounts;

UPDATE accounts
SET quota_subject_id = 'quota_' || id
WHERE quota_subject_id IS NULL OR quota_subject_id = '';

CREATE INDEX IF NOT EXISTS idx_accounts_quota_subject
  ON accounts(quota_subject_id);

CREATE TABLE IF NOT EXISTS device_anchors (
  anchor_hash TEXT PRIMARY KEY NOT NULL,
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_anchors_quota_subject
  ON device_anchors(quota_subject_id);

ALTER TABLE devices ADD COLUMN device_anchor_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_anchor_hash
  ON devices(device_anchor_hash);

CREATE TABLE IF NOT EXISTS quota_usage_periods (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  used_credits INTEGER NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  prepaid_credits INTEGER NOT NULL DEFAULT 0 CHECK (prepaid_credits >= 0),
  PRIMARY KEY (quota_subject_id, period_key)
);

CREATE TABLE IF NOT EXISTS quota_usage_events (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id) ON DELETE CASCADE,
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
  apply_usage INTEGER NOT NULL DEFAULT 1 CHECK (apply_usage IN (0, 1)),
  PRIMARY KEY (quota_subject_id, period_key, event_id)
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_events_charged_at
  ON quota_usage_events(charged_at);

INSERT OR IGNORE INTO quota_usage_periods (
  quota_subject_id,
  period_key,
  period_start,
  period_end,
  used_credits,
  prepaid_credits
)
SELECT
  accounts.quota_subject_id,
  usage_periods.period_key,
  usage_periods.period_start,
  usage_periods.period_end,
  usage_periods.used_credits,
  usage_periods.prepaid_credits
FROM usage_periods
JOIN accounts ON accounts.id = usage_periods.account_id
WHERE accounts.quota_subject_id IS NOT NULL;

INSERT OR IGNORE INTO quota_usage_events (
  quota_subject_id,
  period_key,
  event_id,
  credits,
  billing_mode,
  monthly_credits,
  period_start,
  period_end,
  charged_at,
  apply_usage
)
SELECT
  accounts.quota_subject_id,
  usage_events.period_key,
  usage_events.event_id,
  usage_events.credits,
  usage_events.billing_mode,
  usage_events.monthly_credits,
  usage_events.period_start,
  usage_events.period_end,
  usage_events.charged_at,
  0
FROM usage_events
JOIN accounts ON accounts.id = usage_events.account_id
WHERE accounts.quota_subject_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_quota_usage_event_apply;

CREATE TRIGGER trg_quota_usage_event_apply
BEFORE INSERT ON quota_usage_events
WHEN NEW.apply_usage = 1
BEGIN
  INSERT INTO quota_usage_periods (
    quota_subject_id,
    period_key,
    period_start,
    period_end,
    used_credits,
    prepaid_credits
  )
  VALUES (
    NEW.quota_subject_id,
    NEW.period_key,
    NEW.period_start,
    NEW.period_end,
    0,
    0
  )
  ON CONFLICT(quota_subject_id, period_key) DO NOTHING;

  SELECT RAISE(ABORT, 'quota_exhausted')
  WHERE NEW.billing_mode = 'prepaid-metered'
    AND (
      SELECT prepaid_credits
      FROM quota_usage_periods
      WHERE quota_subject_id = NEW.quota_subject_id
        AND period_key = NEW.period_key
    ) < NEW.credits;

  SELECT RAISE(ABORT, 'quota_exhausted')
  WHERE NEW.billing_mode <> 'prepaid-metered'
    AND NEW.monthly_credits IS NOT NULL
    AND (
      SELECT used_credits
      FROM quota_usage_periods
      WHERE quota_subject_id = NEW.quota_subject_id
        AND period_key = NEW.period_key
    ) + NEW.credits > NEW.monthly_credits;

  UPDATE quota_usage_periods
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
  WHERE quota_subject_id = NEW.quota_subject_id
    AND period_key = NEW.period_key;
END;
