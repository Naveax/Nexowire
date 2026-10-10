-- Queued command intents are dormant until independently authenticated and claimed.
-- This migration never translates historical device_bridge_preferences into commands.
CREATE TABLE IF NOT EXISTS device_bridge_commands (
  request_id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_binding TEXT NOT NULL,
  desired_mode TEXT NOT NULL CHECK(desired_mode IN ('auto','on','off')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','claimed','applied','failed')),
  claimed_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  CHECK (expires_at > issued_at),
  CHECK (status <> 'queued' OR (claimed_at IS NULL AND completed_at IS NULL)),
  CHECK (status <> 'claimed' OR (claimed_at IS NOT NULL AND completed_at IS NULL)),
  CHECK (status NOT IN ('applied','failed') OR (claimed_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_bridge_commands_device_expiry
  ON device_bridge_commands(device_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_bridge_commands_owner
  ON device_bridge_commands(owner_account_id,issued_at);
