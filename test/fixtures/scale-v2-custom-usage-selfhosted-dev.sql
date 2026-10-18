-- DEV/OWNER-OPERATED TRUSTED HUB PROPOSAL ONLY.
-- This is NOT a Cloudflare production migration and MUST NOT be installed on user-owned
-- devices as the authoritative SaaS meter (customers can alter local SQLite files).
CREATE TABLE custom_usage_daily (
  quota_subject_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
  PRIMARY KEY(quota_subject_id, day_utc)
);
CREATE TABLE custom_usage_invocation_replay (
  quota_subject_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(quota_subject_id, invocation_id)
);
CREATE TABLE custom_usage_tunnel_clock (
  transport_scope TEXT PRIMARY KEY,
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE custom_usage_transport_window (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transport_scope TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL
);
CREATE INDEX custom_usage_transport_window_ix
  ON custom_usage_transport_window(transport_scope, accepted_at_ms);
