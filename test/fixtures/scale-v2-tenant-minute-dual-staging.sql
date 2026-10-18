-- Scale v2 S2/S4 DEV/STAGING ONLY, never apply under cloudflare/migrations.
-- Apply AFTER: base migrations + daily-requests + dual-quota staging fixtures.
-- Only a validated, server-issued entitlement epoch can reserve. One INSERT,
-- including nested daily and monthly triggers, is atomic in SQLite.
CREATE TABLE v2_quota_authority (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tenant_id TEXT NOT NULL,
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  tier TEXT NOT NULL CHECK(tier IN ('free','plus','pro','enterprise')),
  daily_limit INTEGER NOT NULL CHECK(daily_limit > 0),
  minute_limit INTEGER CHECK(minute_limit IS NULL OR minute_limit > 0),
  monthly_credits INTEGER NOT NULL CHECK(monthly_credits > 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  PRIMARY KEY(account_id, tenant_id)
);
CREATE INDEX v2_quota_authority_by_subject ON v2_quota_authority(quota_subject_id);

CREATE TABLE v2_quota_reservations (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tenant_id TEXT NOT NULL,
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id),
  device_id TEXT REFERENCES devices(id),
  invocation_id TEXT NOT NULL CHECK(length(invocation_id) BETWEEN 8 AND 128),
  plan_tier TEXT NOT NULL CHECK(plan_tier IN ('free','plus','pro','enterprise')),
  entitlement_revision INTEGER NOT NULL CHECK(entitlement_revision > 0),
  day_key TEXT NOT NULL CHECK(length(day_key) = 10),
  accepted_at TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
  daily_limit INTEGER NOT NULL CHECK(daily_limit > 0),
  minute_limit INTEGER CHECK(minute_limit IS NULL OR minute_limit > 0),
  period_key TEXT NOT NULL CHECK(length(period_key) = 7),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  tool_credits INTEGER NOT NULL CHECK(tool_credits > 0),
  monthly_credits INTEGER NOT NULL CHECK(monthly_credits > 0),
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('free','subscription')),
  PRIMARY KEY(quota_subject_id, invocation_id)
);
CREATE TABLE v2_quota_minute_events (
  quota_subject_id TEXT NOT NULL REFERENCES quota_subjects(id),
  invocation_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(quota_subject_id, invocation_id)
);
CREATE INDEX v2_quota_minute_lookup
 ON v2_quota_minute_events(quota_subject_id, accepted_at_ms);
CREATE TABLE v2_quota_clock (
  quota_subject_id TEXT PRIMARY KEY REFERENCES quota_subjects(id),
  last_seen_ms INTEGER NOT NULL
);

CREATE TRIGGER v2_quota_admission BEFORE INSERT ON v2_quota_reservations
BEGIN
  SELECT RAISE(ABORT,'v2_entitlement_epoch_invalid') WHERE NOT EXISTS(
    SELECT 1 FROM v2_quota_authority a
    WHERE a.account_id=NEW.account_id AND a.tenant_id=NEW.tenant_id
      AND a.quota_subject_id=NEW.quota_subject_id
      AND a.revision=NEW.entitlement_revision AND a.state='active'
      AND a.tier=NEW.plan_tier AND a.daily_limit=NEW.daily_limit
      AND COALESCE(a.minute_limit,-1)=COALESCE(NEW.minute_limit,-1)
      AND a.monthly_credits=NEW.monthly_credits
  );
  SELECT RAISE(ABORT,'v2_account_subject_invalid') WHERE NOT EXISTS(
    SELECT 1 FROM accounts a WHERE a.id=NEW.account_id
      AND a.quota_subject_id=NEW.quota_subject_id
      AND a.plan_id=CASE WHEN NEW.plan_tier='enterprise'
        THEN 'custom' ELSE NEW.plan_tier END
  );
  SELECT RAISE(ABORT,'v2_wrong_device_owner') WHERE NEW.device_id IS NOT NULL
    AND NOT EXISTS(
      SELECT 1 FROM devices d
       WHERE d.id=NEW.device_id AND d.owner_account_id=NEW.account_id
    );
  SELECT RAISE(ABORT,'v2_paid_tenant_conflict')
   WHERE NEW.billing_mode='subscription' AND EXISTS(
     SELECT 1 FROM v2_quota_authority a
       WHERE a.quota_subject_id=NEW.quota_subject_id
         AND a.tenant_id<>NEW.tenant_id
         AND a.state='active'
   );
  SELECT RAISE(ABORT,'v2_invalid_period') WHERE
    strftime('%Y-%m-%d',NEW.accepted_at_ms/1000,'unixepoch')<>NEW.day_key OR
    substr(NEW.day_key,1,7)<>NEW.period_key OR
    NEW.period_start<>NEW.period_key||'-01T00:00:00.000Z' OR
    strftime('%Y-%m-%dT%H:%M:%fZ',NEW.accepted_at_ms/1000.0,'unixepoch')<>NEW.accepted_at;
  SELECT RAISE(ABORT,'v2_clock_rewind') WHERE EXISTS(
    SELECT 1 FROM v2_quota_clock c
     WHERE c.quota_subject_id=NEW.quota_subject_id
       AND c.last_seen_ms>NEW.accepted_at_ms
  );
  SELECT RAISE(ABORT,'v2_minute_exhausted')
  WHERE NEW.minute_limit IS NOT NULL AND
   (SELECT COUNT(*) FROM v2_quota_minute_events m
    WHERE m.quota_subject_id=NEW.quota_subject_id
      AND m.accepted_at_ms>NEW.accepted_at_ms-60000
      AND m.accepted_at_ms<=NEW.accepted_at_ms)>=NEW.minute_limit;
END;

CREATE TRIGGER v2_quota_commit AFTER INSERT ON v2_quota_reservations
BEGIN
  INSERT INTO dual_quota_reservations
    (quota_subject_id,invocation_id,day_key,daily_limit,period_key,
     period_start,period_end,tool_credits,billing_mode,monthly_credits,accepted_at)
  VALUES
    (NEW.quota_subject_id,NEW.invocation_id,NEW.day_key,NEW.daily_limit,
     NEW.period_key,NEW.period_start,NEW.period_end,NEW.tool_credits,
     NEW.billing_mode,NEW.monthly_credits,NEW.accepted_at);
  INSERT INTO v2_quota_minute_events(quota_subject_id,invocation_id,accepted_at_ms)
   VALUES(NEW.quota_subject_id,NEW.invocation_id,NEW.accepted_at_ms);
  INSERT INTO v2_quota_clock(quota_subject_id,last_seen_ms)
   VALUES(NEW.quota_subject_id,NEW.accepted_at_ms)
   ON CONFLICT(quota_subject_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms;
END;
