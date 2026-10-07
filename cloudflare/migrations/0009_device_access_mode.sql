ALTER TABLE devices
ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'safe'
CHECK (access_mode IN ('safe', 'full'));

CREATE INDEX IF NOT EXISTS idx_devices_access_mode
ON devices(access_mode);
