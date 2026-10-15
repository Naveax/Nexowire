-- S1 STAGING-ONLY account-wide OAuth logout experiment.
-- DO NOT add to cloudflare/migrations. No live endpoint or production rollout.
-- This prototype intentionally locks account re-authorization until an
-- independently designed, authorized recovery/session epoch is available.
CREATE TABLE mcp_oauth_account_logout_gate (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  logout_id TEXT NOT NULL UNIQUE CHECK(length(logout_id) BETWEEN 8 AND 128),
  revoked_at TEXT NOT NULL
);

CREATE TRIGGER trg_staging_oauth_account_logout_apply
AFTER INSERT ON mcp_oauth_account_logout_gate
BEGIN
  UPDATE mcp_oauth_access_tokens
    SET expires_at = NEW.revoked_at
    WHERE account_id = NEW.account_id AND expires_at > NEW.revoked_at;
  UPDATE mcp_oauth_refresh_tokens
    SET revoked_at = NEW.revoked_at
    WHERE account_id = NEW.account_id AND revoked_at IS NULL;
  UPDATE mcp_oauth_codes
    SET consumed_at = NEW.revoked_at
    WHERE account_id = NEW.account_id AND consumed_at IS NULL;
END;

-- Concurrency fail-safe: an in-flight refresh/code exchange that attempts to
-- mint tokens after the logout marker is committed cannot bypass account
-- revocation. New legitimate login is also blocked, intentionally; a future
-- session epoch/approved reauthorization flow is still required.
CREATE TRIGGER trg_staging_block_oauth_new_access_after_logout
BEFORE INSERT ON mcp_oauth_access_tokens
WHEN EXISTS (SELECT 1 FROM mcp_oauth_account_logout_gate WHERE account_id=NEW.account_id)
BEGIN
  SELECT RAISE(ABORT,'oauth_account_logout_locked');
END;

CREATE TRIGGER trg_staging_block_oauth_new_refresh_after_logout
BEFORE INSERT ON mcp_oauth_refresh_tokens
WHEN EXISTS (SELECT 1 FROM mcp_oauth_account_logout_gate WHERE account_id=NEW.account_id)
BEGIN
  SELECT RAISE(ABORT,'oauth_account_logout_locked');
END;

CREATE TRIGGER trg_staging_block_oauth_new_code_after_logout
BEFORE INSERT ON mcp_oauth_codes
WHEN EXISTS (SELECT 1 FROM mcp_oauth_account_logout_gate WHERE account_id=NEW.account_id)
BEGIN
  SELECT RAISE(ABORT,'oauth_account_logout_locked');
END;
