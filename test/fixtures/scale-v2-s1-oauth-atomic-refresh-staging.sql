-- S1 STAGING-ONLY OAuth refresh-token rotation proposal.
-- Requires the prior session-epoch staging fixture and 0005_mcp_oauth.sql.
-- Deliberately NEVER deployed or imported by the live OAuth Worker.
CREATE TABLE mcp_oauth_epoch_refresh_rotations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  old_refresh_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  session_epoch INTEGER NOT NULL CHECK(session_epoch >= 0),
  rotated_at TEXT NOT NULL,
  new_access_hash TEXT NOT NULL UNIQUE,
  new_refresh_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL
);

-- A *single* top-level INSERT reserves the rotation, consumes the previous
-- refresh credential AND inserts its replacement access/refresh pair.
-- Any denied, duplicate or incomplete step aborts the entire operation.
CREATE TRIGGER trg_staging_oauth_atomic_epoch_refresh
BEFORE INSERT ON mcp_oauth_epoch_refresh_rotations
BEGIN
  SELECT RAISE(ABORT,'oauth_refresh_session_epoch_locked')
  WHERE NOT EXISTS (
    SELECT 1 FROM mcp_oauth_session_epochs AS e
    WHERE e.account_id=NEW.account_id AND e.locked=0
      AND e.generation=NEW.session_epoch
  );

  SELECT RAISE(ABORT,'oauth_refresh_old_token_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM mcp_oauth_refresh_tokens AS r
    WHERE r.token_hash=NEW.old_refresh_hash
      AND r.account_id=NEW.account_id
      AND r.client_id=NEW.client_id
      AND r.resource=NEW.resource
      AND r.scopes_json=NEW.scopes_json
      AND r.session_epoch=NEW.session_epoch
      AND r.revoked_at IS NULL
      AND r.expires_at>NEW.rotated_at
  );

  UPDATE mcp_oauth_refresh_tokens
  SET revoked_at=NEW.rotated_at
  WHERE token_hash=NEW.old_refresh_hash AND revoked_at IS NULL
    AND account_id=NEW.account_id
    AND client_id=NEW.client_id
    AND resource=NEW.resource
    AND session_epoch=NEW.session_epoch
    AND expires_at>NEW.rotated_at;

  SELECT RAISE(ABORT,'oauth_refresh_consume_cas_failed')
  WHERE changes()<>1;

  INSERT INTO mcp_oauth_access_tokens
    (token_hash,client_id,account_id,resource,scopes_json,
     expires_at,created_at,session_epoch)
  VALUES
    (NEW.new_access_hash,NEW.client_id,NEW.account_id,NEW.resource,
     NEW.scopes_json,NEW.access_expires_at,NEW.rotated_at,NEW.session_epoch);

  INSERT INTO mcp_oauth_refresh_tokens
    (token_hash,client_id,account_id,resource,scopes_json,
     expires_at,revoked_at,created_at,session_epoch)
  VALUES
    (NEW.new_refresh_hash,NEW.client_id,NEW.account_id,NEW.resource,
     NEW.scopes_json,NEW.refresh_expires_at,NULL,NEW.rotated_at,NEW.session_epoch);
END;
