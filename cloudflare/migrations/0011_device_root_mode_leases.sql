-- DANGER Root Mode is a temporary owner-maintenance lease, not OS elevation.
CREATE TABLE IF NOT EXISTS device_root_mode_leases (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_root_leases_expiry
ON device_root_mode_leases(expires_at);

-- Root DANGER activation/revocation is always auditable without reading secrets.
CREATE TABLE IF NOT EXISTS device_root_mode_events (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('enable', 'disable')),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_root_mode_events_recorded_at
ON device_root_mode_events(recorded_at);

CREATE TRIGGER IF NOT EXISTS trg_root_mode_audit_insert
AFTER INSERT ON device_root_mode_leases
BEGIN
  INSERT INTO device_root_mode_events
  (id, device_id, owner_account_id, operation, expires_at, recorded_at)
  VALUES
  (lower(hex(randomblob(16))), NEW.device_id, NEW.owner_account_id,
   CASE WHEN NEW.expires_at > NEW.updated_at THEN 'enable' ELSE 'disable' END,
   NEW.expires_at, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_root_mode_audit_update
AFTER UPDATE ON device_root_mode_leases
BEGIN
  INSERT INTO device_root_mode_events
  (id, device_id, owner_account_id, operation, expires_at, recorded_at)
  VALUES
  (lower(hex(randomblob(16))), NEW.device_id, NEW.owner_account_id,
   CASE WHEN NEW.expires_at > NEW.updated_at THEN 'enable' ELSE 'disable' END,
   NEW.expires_at, NEW.updated_at);
END;
