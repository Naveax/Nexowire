-- CORE is a revocable owner preference, never an OS privilege grant.
CREATE TABLE IF NOT EXISTS device_maintenance_preferences (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_maintenance_events (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('enable', 'disable')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_maintenance_events_time
ON device_maintenance_events(recorded_at);
CREATE TRIGGER IF NOT EXISTS trg_maintenance_insert
AFTER INSERT ON device_maintenance_preferences BEGIN
  INSERT INTO device_maintenance_events
  (id,device_id,owner_account_id,operation,recorded_at)
  VALUES (lower(hex(randomblob(16))),NEW.device_id,NEW.owner_account_id,
    CASE WHEN NEW.enabled = 1 THEN 'enable' ELSE 'disable' END,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_maintenance_update
AFTER UPDATE ON device_maintenance_preferences BEGIN
  INSERT INTO device_maintenance_events
  (id,device_id,owner_account_id,operation,recorded_at)
  VALUES (lower(hex(randomblob(16))),NEW.device_id,NEW.owner_account_id,
    CASE WHEN NEW.enabled = 1 THEN 'enable' ELSE 'disable' END,NEW.updated_at);
END;
