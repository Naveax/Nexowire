-- SCALE V2 / S2 CANDIDATE ONLY.
-- Additive schema for staging. NOT applied to production Worker/D1.
-- The real active quota_usage_* tables remain unchanged.
CREATE TABLE IF NOT EXISTS daily_request_periods (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL CHECK (length(day_key) = 10),
  used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
  PRIMARY KEY (quota_subject_id, day_key)
);

-- The idempotency namespace intentionally has NO day key in its primary key.
-- Reusing a logical invocation ID after UTC midnight cannot execute twice.
CREATE TABLE IF NOT EXISTS daily_request_invocations (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 8 AND 128),
  day_key TEXT NOT NULL CHECK (length(day_key) = 10),
  daily_limit INTEGER NOT NULL CHECK (daily_limit > 0),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (quota_subject_id, invocation_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_request_invocations_day
  ON daily_request_invocations(quota_subject_id, day_key);

-- One SQLite INSERT is one atomic transaction, including these mutations.
-- A failed INSERT rolls back the trigger's period INSERT/UPDATE as well.
CREATE TRIGGER IF NOT EXISTS trg_daily_request_invocation_admit
BEFORE INSERT ON daily_request_invocations
BEGIN
  INSERT INTO daily_request_periods
    (quota_subject_id, day_key, used_requests)
  VALUES (NEW.quota_subject_id, NEW.day_key, 0)
  ON CONFLICT(quota_subject_id, day_key) DO NOTHING;

  SELECT RAISE(ABORT, 'daily_request_limit_exhausted')
  WHERE (
    SELECT used_requests
    FROM daily_request_periods
    WHERE quota_subject_id = NEW.quota_subject_id
      AND day_key = NEW.day_key
  ) >= NEW.daily_limit;

  UPDATE daily_request_periods
  SET used_requests = used_requests + 1
  WHERE quota_subject_id = NEW.quota_subject_id
    AND day_key = NEW.day_key;
END;
