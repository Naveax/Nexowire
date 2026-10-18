-- DEV/STAGING ONLY: OAuth authorization-code redemption and token issuance
-- in exactly ONE SQLite statement. Requires preceding S1 epoch fixture.
-- NEVER copy into cloudflare/migrations or run on live D1.
CREATE TABLE mcp_oauth_epoch_code_redemptions (
  operation_id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  session_epoch INTEGER NOT NULL CHECK(session_epoch >= 0),
  redeemed_at TEXT NOT NULL,
  new_access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  new_refresh_hash TEXT UNIQUE,
  refresh_expires_at TEXT
);

CREATE TRIGGER trg_staging_oauth_atomic_epoch_code
BEFORE INSERT ON mcp_oauth_epoch_code_redemptions
BEGIN
  SELECT RAISE(ABORT,'oauth_code_epoch_locked')
  WHERE NOT EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs AS e
    WHERE e.account_id=NEW.account_id AND e.locked=0
      AND e.generation=NEW.session_epoch
  );

  SELECT RAISE(ABORT,'oauth_code_invalid_or_mismatched')
  WHERE NOT EXISTS (
    SELECT 1 FROM mcp_oauth_codes AS c
    WHERE c.code_hash=NEW.code_hash
      AND c.account_id=NEW.account_id
      AND c.client_id=NEW.client_id
      AND c.resource=NEW.resource
      AND c.redirect_uri=NEW.redirect_uri
      AND c.code_challenge=NEW.code_challenge
      AND c.scopes_json=NEW.scopes_json
      AND c.session_epoch=NEW.session_epoch
      AND c.consumed_at IS NULL
      AND c.expires_at>NEW.redeemed_at
  );

  SELECT RAISE(ABORT,'oauth_code_refresh_scope_inconsistent')
  WHERE (
    EXISTS (SELECT 1 FROM json_each(NEW.scopes_json)
      WHERE value='offline_access')
    AND (NEW.new_refresh_hash IS NULL OR NEW.refresh_expires_at IS NULL)
  ) OR (
    NOT EXISTS (SELECT 1 FROM json_each(NEW.scopes_json)
      WHERE value='offline_access')
    AND (NEW.new_refresh_hash IS NOT NULL OR NEW.refresh_expires_at IS NOT NULL)
  );

  UPDATE mcp_oauth_codes
  SET consumed_at=NEW.redeemed_at
  WHERE code_hash=NEW.code_hash
    AND account_id=NEW.account_id
    AND client_id=NEW.client_id
    AND resource=NEW.resource
    AND redirect_uri=NEW.redirect_uri
    AND code_challenge=NEW.code_challenge
    AND session_epoch=NEW.session_epoch
    AND consumed_at IS NULL
    AND expires_at>NEW.redeemed_at;

  SELECT RAISE(ABORT,'oauth_code_consume_cas_failed')
  WHERE changes()<>1;

  INSERT INTO mcp_oauth_access_tokens (
    token_hash,client_id,account_id,resource,scopes_json,
    expires_at,created_at,session_epoch
  ) VALUES (
    NEW.new_access_hash,NEW.client_id,NEW.account_id,NEW.resource,
    NEW.scopes_json,NEW.access_expires_at,NEW.redeemed_at,NEW.session_epoch
  );

  INSERT INTO mcp_oauth_refresh_tokens (
    token_hash,client_id,account_id,resource,scopes_json,
    expires_at,revoked_at,created_at,session_epoch
  )
  SELECT
    NEW.new_refresh_hash,NEW.client_id,NEW.account_id,NEW.resource,
    NEW.scopes_json,NEW.refresh_expires_at,NULL,NEW.redeemed_at,NEW.session_epoch
  WHERE NEW.new_refresh_hash IS NOT NULL;
END;
