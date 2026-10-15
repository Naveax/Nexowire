-- Scale v2 S1 - STAGING ONLY, not a production migration.
-- Apply AFTER scale-v2-s1-oauth-logout-staging.sql and existing OAuth schema
-- with all old writers quiesced. This fixture replaces permanent lock guards
-- with monotonically increasing owner session epochs and repeated logouts.
-- DO NOT copy this fixture into cloudflare/migrations/.
ALTER TABLE mcp_oauth_access_tokens
  ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0);
ALTER TABLE mcp_oauth_refresh_tokens
  ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0);
ALTER TABLE mcp_oauth_codes
  ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0);

CREATE TABLE mcp_oauth_session_epochs (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  locked INTEGER NOT NULL CHECK(locked IN (0,1)),
  changed_at TEXT NOT NULL
);

-- Existing v1 hard locks must remain locked during migration. Never reenable
-- legacy tokens at session epoch 0 for accounts with historical logout gates.
INSERT INTO mcp_oauth_session_epochs(account_id,generation,locked,changed_at)
  SELECT account_id,1,1,revoked_at FROM mcp_oauth_account_logout_gate;

CREATE TABLE mcp_oauth_session_epoch_events (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK(length(operation_id) BETWEEN 8 AND 128),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('logout','reauth')),
  expected_generation INTEGER NOT NULL CHECK(expected_generation >= 0),
  changed_at TEXT NOT NULL
);

-- Old irreversible guard was a DEV-only predecessor. We retain the old
-- logout gate row for audit/backfill, but replace the old permanent block.
DROP TRIGGER trg_staging_block_oauth_new_access_after_logout;
DROP TRIGGER trg_staging_block_oauth_new_refresh_after_logout;
DROP TRIGGER trg_staging_block_oauth_new_code_after_logout;

-- One top-level INSERT transitions a single account generation. Failed CAS,
-- duplicate operation, or provider error aborts the whole statement.
CREATE TRIGGER trg_staging_oauth_epoch_transition
BEFORE INSERT ON mcp_oauth_session_epoch_events
BEGIN
  INSERT INTO mcp_oauth_session_epochs
    (account_id,generation,locked,changed_at)
  VALUES (NEW.account_id,0,0,NEW.changed_at)
  ON CONFLICT(account_id) DO NOTHING;

  SELECT RAISE(ABORT,'oauth_session_epoch_stale_or_locked')
  WHERE NOT EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
      AND generation=NEW.expected_generation
      AND locked=CASE WHEN NEW.kind='logout' THEN 0 ELSE 1 END
  );

  UPDATE mcp_oauth_session_epochs
  SET generation=generation+1,
      locked=CASE WHEN NEW.kind='logout' THEN 1 ELSE 0 END,
      changed_at=NEW.changed_at
  WHERE account_id=NEW.account_id
    AND generation=NEW.expected_generation;

  SELECT RAISE(ABORT,'oauth_session_epoch_cas_failed')
  WHERE changes() <> 1;
END;

CREATE TRIGGER trg_staging_oauth_epoch_logout_tokens
AFTER INSERT ON mcp_oauth_session_epoch_events
WHEN NEW.kind='logout'
BEGIN
  UPDATE mcp_oauth_access_tokens SET expires_at=NEW.changed_at
  WHERE account_id=NEW.account_id AND expires_at>NEW.changed_at;

  UPDATE mcp_oauth_refresh_tokens SET revoked_at=NEW.changed_at
  WHERE account_id=NEW.account_id AND revoked_at IS NULL;

  UPDATE mcp_oauth_codes SET consumed_at=NEW.changed_at
  WHERE account_id=NEW.account_id AND consumed_at IS NULL;
END;

-- Token issuance is coupled to the CURRENT unlocked epoch at SQL commit.
-- Legacy OAuth D1 writes without session_epoch remain compatible only for
-- accounts which have never used the new lifecycle (implicit generation 0).
-- They fail closed for any account that has logged out or reauthenticated.
CREATE TRIGGER trg_staging_access_epoch_required
BEFORE INSERT ON mcp_oauth_access_tokens
WHEN NOT (
  (NEW.session_epoch=0 AND NOT EXISTS(
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
  ))
  OR EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
      AND generation=NEW.session_epoch AND locked=0
  )
)
BEGIN
  SELECT RAISE(ABORT,'oauth_access_session_epoch_denied');
END;

CREATE TRIGGER trg_staging_refresh_epoch_required
BEFORE INSERT ON mcp_oauth_refresh_tokens
WHEN NOT (
  (NEW.session_epoch=0 AND NOT EXISTS(
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
  ))
  OR EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
      AND generation=NEW.session_epoch AND locked=0
  )
)
BEGIN
  SELECT RAISE(ABORT,'oauth_refresh_session_epoch_denied');
END;

CREATE TRIGGER trg_staging_code_epoch_required
BEFORE INSERT ON mcp_oauth_codes
WHEN NOT (
  (NEW.session_epoch=0 AND NOT EXISTS(
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
  ))
  OR EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs
    WHERE account_id=NEW.account_id
      AND generation=NEW.session_epoch AND locked=0
  )
)
BEGIN
  SELECT RAISE(ABORT,'oauth_code_session_epoch_denied');
END;
