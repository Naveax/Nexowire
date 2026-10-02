ALTER TABLE pairings ADD COLUMN requested_device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pairings_requested_device
  ON pairings(requested_device_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_credential_hash
  ON devices(credential_hash);
