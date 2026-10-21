-- #617/#322/#323 CORE local enrollment ledger. SOURCE-ONLY.
-- NEVER means UAC, token or Broker installation has been proven.
-- Additive migration for isolated staging tests; no production D1 write.
CREATE TABLE IF NOT EXISTS core_admin_delegations (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL CHECK(length(credential_hash)=64),
  generation INTEGER NOT NULL CHECK(generation>=1),
  enrollment_id TEXT NOT NULL UNIQUE,
  local_broker_identity_sha256 TEXT NOT NULL CHECK(length(local_broker_identity_sha256)=64),
  signing_key_sha256 TEXT NOT NULL CHECK(length(signing_key_sha256)=64),
  bootstrap_proof_sha256 TEXT NOT NULL CHECK(length(bootstrap_proof_sha256)=64),
  broker_version TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(revoked_at IS NULL OR revoked_at>=enrolled_at)
);
CREATE INDEX IF NOT EXISTS idx_core_admin_delegation_owner
  ON core_admin_delegations(owner_account_id,device_id);
-- Append-only history prevents a previously revoked signed request from being
-- reused after a later enrollment (even after account or device re-pair).
CREATE TABLE IF NOT EXISTS core_admin_consumed_enrollments (
  enrollment_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

-- CORE preference disable/OFF is a durable revoke; it cannot be revived by
-- toggling the preference on again without new signed local enrollment.
CREATE TRIGGER IF NOT EXISTS trg_core_admin_disable
AFTER UPDATE OF enabled ON device_maintenance_preferences
WHEN NEW.enabled=0
BEGIN
  UPDATE core_admin_delegations SET revoked_at=
    CASE WHEN NEW.updated_at>=enrolled_at THEN NEW.updated_at ELSE enrolled_at END
  WHERE device_id=NEW.device_id AND revoked_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_core_admin_preference_removed
AFTER DELETE ON device_maintenance_preferences
BEGIN
  UPDATE core_admin_delegations SET revoked_at=
    CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ','now')>=enrolled_at
      THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE enrolled_at END
  WHERE device_id=OLD.device_id AND revoked_at IS NULL;
END;
-- SAFE, re-pair, owner change and Broker mode removal cannot revive grants
-- after an ordinary reconnect or subsequent preference toggle.
CREATE TRIGGER IF NOT EXISTS trg_core_admin_device_identity_change
AFTER UPDATE OF owner_account_id,credential_hash,access_mode,privilege_mode ON devices
WHEN NEW.owner_account_id<>OLD.owner_account_id OR
     NEW.credential_hash<>OLD.credential_hash OR
     NEW.access_mode='safe' OR NEW.privilege_mode IS NOT 'broker'
BEGIN
  UPDATE core_admin_delegations SET revoked_at=
    CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ','now')>=enrolled_at
      THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE enrolled_at END
  WHERE device_id=NEW.id AND revoked_at IS NULL;
END;
