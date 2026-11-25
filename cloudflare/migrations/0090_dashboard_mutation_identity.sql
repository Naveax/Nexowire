-- Dashboard intent identity is not an authorization grant or an OS receipt.
-- Keep tombstones across deletion/re-pair; never store raw tokens, input or credentials.
CREATE TABLE IF NOT EXISTS dashboard_mutation_claims (
 mutation_id TEXT PRIMARY KEY NOT NULL,
 owner_account_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('pairing','core-enable','core-disable','core-consent')),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 execution_nonce TEXT NOT NULL UNIQUE,
 expected_revision INTEGER,
 state TEXT NOT NULL CHECK(state IN ('PENDING','APPLIED','DENIED')),
 created_at TEXT NOT NULL,
 CHECK((kind='pairing' AND expected_revision IS NULL) OR
       (kind<>'pairing' AND expected_revision IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS dashboard_mutation_immutable_delete
 BEFORE DELETE ON dashboard_mutation_claims BEGIN
 SELECT RAISE(ABORT,'DASHBOARD_MUTATION_TOMBSTONE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dashboard_mutation_immutable_update
 BEFORE UPDATE ON dashboard_mutation_claims
 WHEN OLD.state<>'PENDING' OR NEW.state<>'APPLIED' OR
 OLD.mutation_id<>NEW.mutation_id OR OLD.owner_account_id<>NEW.owner_account_id OR
 OLD.device_id<>NEW.device_id OR OLD.kind<>NEW.kind OR OLD.payload_sha256<>NEW.payload_sha256 OR
 OLD.execution_nonce<>NEW.execution_nonce OR OLD.expected_revision IS NOT NEW.expected_revision OR
 OLD.created_at<>NEW.created_at
 BEGIN SELECT RAISE(ABORT,'DASHBOARD_MUTATION_TOMBSTONE_IMMUTABLE'); END;

-- Retain revision on deletion, so a recreated device cannot reuse an old CAS.
CREATE TABLE IF NOT EXISTS dashboard_core_revisions (
 device_id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
);
INSERT OR IGNORE INTO dashboard_core_revisions SELECT id,1 FROM devices;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_device_insert AFTER INSERT ON devices BEGIN
 INSERT INTO dashboard_core_revisions VALUES(NEW.id,1)
 ON CONFLICT(device_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_device_update
 AFTER UPDATE OF owner_account_id,credential_hash,access_mode,online,platform,privilege_mode,admin_bridge_ready ON devices
 WHEN OLD.owner_account_id IS NOT NEW.owner_account_id OR OLD.credential_hash IS NOT NEW.credential_hash OR
 OLD.access_mode IS NOT NEW.access_mode OR OLD.online IS NOT NEW.online OR OLD.platform IS NOT NEW.platform OR
 OLD.privilege_mode IS NOT NEW.privilege_mode OR OLD.admin_bridge_ready IS NOT NEW.admin_bridge_ready
 BEGIN UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_device_delete AFTER DELETE ON devices BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=OLD.id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_console_update
 AFTER UPDATE ON device_core_console_authority
 WHEN OLD.owner_epoch IS NOT NEW.owner_epoch OR OLD.grant_generation IS NOT NEW.grant_generation OR
 OLD.revoke_epoch IS NOT NEW.revoke_epoch OR OLD.enrollment_requested IS NOT NEW.enrollment_requested OR
 OLD.enrollment_id IS NOT NEW.enrollment_id OR OLD.installation_id IS NOT NEW.installation_id
 BEGIN UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_pref_insert AFTER INSERT ON device_maintenance_preferences BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_pref_update AFTER UPDATE ON device_maintenance_preferences
 WHEN OLD.enabled IS NOT NEW.enabled OR OLD.owner_account_id IS NOT NEW.owner_account_id
 BEGIN UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_pref_delete AFTER DELETE ON device_maintenance_preferences BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=OLD.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_bridge_insert AFTER INSERT ON device_bridge_preferences BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_bridge_update AFTER UPDATE ON device_bridge_preferences
 WHEN OLD.desired_mode IS NOT NEW.desired_mode OR OLD.owner_account_id IS NOT NEW.owner_account_id
 BEGIN UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_bridge_delete AFTER DELETE ON device_bridge_preferences BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=OLD.device_id; END;

CREATE TRIGGER IF NOT EXISTS dashboard_revision_remote_insert AFTER INSERT ON device_remote_authorization BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_remote_update AFTER UPDATE ON device_remote_authorization
 WHEN OLD.authorization_epoch IS NOT NEW.authorization_epoch OR OLD.active IS NOT NEW.active OR
 OLD.owner_account_id IS NOT NEW.owner_account_id
 BEGIN UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS dashboard_revision_remote_delete AFTER DELETE ON device_remote_authorization BEGIN
 UPDATE dashboard_core_revisions SET revision=revision+1 WHERE device_id=OLD.device_id; END;
