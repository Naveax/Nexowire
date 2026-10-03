CREATE TABLE IF NOT EXISTS control_plane_runtime_config (
  key TEXT PRIMARY KEY NOT NULL,
  encrypted_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_plane_runtime_config_updated
  ON control_plane_runtime_config(updated_at);
