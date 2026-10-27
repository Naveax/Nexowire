-- Physical-console authority is separate from privileged Windows elevation.
CREATE TABLE IF NOT EXISTS device_core_console_authority (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_epoch INTEGER NOT NULL DEFAULT 1,
  grant_generation INTEGER NOT NULL DEFAULT 1,
  revoke_epoch INTEGER NOT NULL DEFAULT 0,
  installation_id TEXT, enrollment_id TEXT, public_key_spki TEXT,
  enrollment_requested INTEGER NOT NULL DEFAULT 0,
  physical_active INTEGER NOT NULL DEFAULT 0, status_observed_at_ms INTEGER
);
INSERT OR IGNORE INTO device_core_console_authority(device_id) SELECT id FROM devices;
CREATE TABLE IF NOT EXISTS device_core_console_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  observed_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_core_console_operations (
  request_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL, grant_generation INTEGER NOT NULL, revoke_epoch INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','succeeded','denied','unknown')),
  reserved_at_ms INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS core_console_new_device AFTER INSERT ON devices BEGIN
  INSERT OR IGNORE INTO device_core_console_authority(device_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS core_console_pairing_changed
AFTER UPDATE OF owner_account_id,credential_hash ON devices
WHEN NEW.owner_account_id<>OLD.owner_account_id OR NEW.credential_hash<>OLD.credential_hash BEGIN
  UPDATE device_core_console_authority SET owner_epoch=owner_epoch+1,revoke_epoch=revoke_epoch+1,
    enrollment_id=NULL,public_key_spki=NULL,installation_id=NULL,enrollment_requested=0,physical_active=0 WHERE device_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_preference_changed
AFTER UPDATE ON device_maintenance_preferences
WHEN NEW.enabled<>OLD.enabled OR NEW.owner_account_id<>OLD.owner_account_id BEGIN
  UPDATE device_core_console_authority SET grant_generation=grant_generation+1,revoke_epoch=revoke_epoch+1,
    enrollment_id=NULL,public_key_spki=NULL,installation_id=NULL,enrollment_requested=NEW.enabled,physical_active=0 WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_preference_insert AFTER INSERT ON device_maintenance_preferences BEGIN
  UPDATE device_core_console_authority SET enrollment_requested=NEW.enabled WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_preference_delete AFTER DELETE ON device_maintenance_preferences BEGIN
  UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1,enrollment_id=NULL,
    public_key_spki=NULL,installation_id=NULL,enrollment_requested=0,physical_active=0 WHERE device_id=OLD.device_id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_bridge_off_insert AFTER INSERT ON device_bridge_preferences
WHEN NEW.desired_mode='off' BEGIN
  UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1,enrollment_id=NULL,
    public_key_spki=NULL,installation_id=NULL,physical_active=0 WHERE device_id=NEW.device_id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_safe AFTER UPDATE OF access_mode ON devices
WHEN NEW.access_mode='safe' AND OLD.access_mode<>'safe' BEGIN
  UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1,
    enrollment_id=NULL,public_key_spki=NULL,installation_id=NULL,physical_active=0 WHERE device_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS core_console_bridge_off AFTER UPDATE ON device_bridge_preferences
WHEN NEW.desired_mode='off' AND OLD.desired_mode<>'off' BEGIN
  UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1,
    enrollment_id=NULL,public_key_spki=NULL,installation_id=NULL,physical_active=0 WHERE device_id=NEW.device_id;
END;
