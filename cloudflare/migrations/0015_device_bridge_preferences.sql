-- This records the owner's desired UI policy only. It does not start or stop a service.
CREATE TABLE IF NOT EXISTS device_bridge_preferences (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  desired_mode TEXT NOT NULL DEFAULT 'auto' CHECK (desired_mode IN ('auto','on','off')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_bridge_preference_events (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  desired_mode TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_preference_events_time
ON device_bridge_preference_events(recorded_at);
CREATE TRIGGER IF NOT EXISTS trg_bridge_preference_insert
AFTER INSERT ON device_bridge_preferences BEGIN
  INSERT INTO device_bridge_preference_events (id,device_id,owner_account_id,desired_mode,recorded_at)
  VALUES (lower(hex(randomblob(16))),NEW.device_id,NEW.owner_account_id,NEW.desired_mode,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_bridge_preference_update
AFTER UPDATE ON device_bridge_preferences BEGIN
  INSERT INTO device_bridge_preference_events (id,device_id,owner_account_id,desired_mode,recorded_at)
  VALUES (lower(hex(randomblob(16))),NEW.device_id,NEW.owner_account_id,NEW.desired_mode,NEW.updated_at);
END;
