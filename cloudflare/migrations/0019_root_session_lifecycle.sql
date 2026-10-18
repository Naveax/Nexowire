-- Login-bound ROOT grants are policy only; never Windows elevation.
-- Legacy device_root_mode_leases must never grant permission without this row.
CREATE TABLE IF NOT EXISTS control_plane_revoked_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64),
  owner_account_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_plane_revoked_session_expiry
  ON control_plane_revoked_sessions(expires_at);

CREATE TABLE IF NOT EXISTS device_root_session_grants (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK(expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS idx_root_session_grants_session
  ON device_root_session_grants(owner_account_id,session_hash);
