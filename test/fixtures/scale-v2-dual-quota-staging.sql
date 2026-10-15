-- Scale v2 / S2 staging-only dual quota fixture.
-- Requires test/fixtures/scale-v2-daily-requests-staging.sql and existing
-- quota_usage_* tables from cloudflare/migrations. NOT a production migration.
CREATE TABLE IF NOT EXISTS dual_quota_reservations (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 8 AND 128),
  day_key TEXT NOT NULL CHECK(length(day_key)=10),
  daily_limit INTEGER NOT NULL CHECK(daily_limit > 0),
  period_key TEXT NOT NULL CHECK(length(period_key)=7),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  tool_credits INTEGER NOT NULL CHECK(tool_credits > 0),
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('free','subscription')),
  monthly_credits INTEGER NOT NULL CHECK(monthly_credits > 0),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (quota_subject_id, invocation_id)
);

-- One statement triggers BOTH existing, independently bounded ledgers.
-- Any RAISE(ABORT), UNIQUE, CHECK, D1/SQLite failure or quota exhaustion
-- rolls back the dual row and all changes in BOTH nested triggers.
CREATE TRIGGER IF NOT EXISTS trg_dual_quota_apply
AFTER INSERT ON dual_quota_reservations
BEGIN
  INSERT INTO daily_request_invocations
    (quota_subject_id, invocation_id, day_key, daily_limit, accepted_at)
  VALUES
    (NEW.quota_subject_id, NEW.invocation_id, NEW.day_key,
     NEW.daily_limit, NEW.accepted_at);

  INSERT INTO quota_usage_events
    (quota_subject_id, period_key, event_id, credits,
     billing_mode, monthly_credits, period_start, period_end,
     charged_at, apply_usage)
  VALUES
    (NEW.quota_subject_id, NEW.period_key, NEW.invocation_id,
     NEW.tool_credits, NEW.billing_mode, NEW.monthly_credits,
     NEW.period_start, NEW.period_end, NEW.accepted_at, 1);
END;
