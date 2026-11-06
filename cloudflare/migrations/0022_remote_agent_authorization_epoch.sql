-- AI-03 Connection v2 authority (0020/0021 reserved for CORE #1067/#1073).
-- Tombstones are deliberately NOT cascade-deleted with a device.
CREATE TABLE IF NOT EXISTS device_remote_authorization (
  device_id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authorization_epoch BETWEEN 1 AND 9007199254740991),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

INSERT OR IGNORE INTO device_remote_authorization
  (device_id, owner_account_id, authorization_epoch, active)
SELECT id, owner_account_id, 1, 0
  FROM devices;

CREATE TRIGGER IF NOT EXISTS trg_remote_authority_device_insert
AFTER INSERT ON devices
BEGIN
  INSERT INTO device_remote_authorization
    (device_id, owner_account_id, authorization_epoch, active)
  VALUES (NEW.id, NEW.owner_account_id, 1, 0)
  ON CONFLICT(device_id) DO UPDATE SET
    owner_account_id = excluded.owner_account_id,
    authorization_epoch = device_remote_authorization.authorization_epoch + 1,
    active = excluded.active;
END;

-- Presence updates do not invalidate leases; credential/owner/policy changes do.
CREATE TRIGGER IF NOT EXISTS trg_remote_authority_device_update
AFTER UPDATE OF owner_account_id, credential_hash, access_mode ON devices
WHEN OLD.owner_account_id IS NOT NEW.owner_account_id
  OR OLD.credential_hash IS NOT NEW.credential_hash
  OR OLD.access_mode IS NOT NEW.access_mode
BEGIN
  UPDATE device_remote_authorization
     SET owner_account_id = NEW.owner_account_id,
         authorization_epoch = authorization_epoch + 1,
         active = CASE
           WHEN OLD.access_mode = 'safe' AND NEW.access_mode = 'full'
            AND OLD.owner_account_id = NEW.owner_account_id
            AND OLD.credential_hash = NEW.credential_hash
           THEN 1 ELSE 0 END
   WHERE device_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_remote_authority_device_delete
AFTER DELETE ON devices
BEGIN
  UPDATE device_remote_authorization
     SET authorization_epoch = authorization_epoch + 1,
         active = 0
   WHERE device_id = OLD.id;
END;

CREATE INDEX IF NOT EXISTS idx_device_remote_authorization_owner
  ON device_remote_authorization(owner_account_id, active);
