-- STAGING ONLY: apply only to an owner-controlled disposable SQLite DB.
CREATE TABLE proposed_owner_wss_profile_revisions (
  device_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE proposed_owner_wss_enrollment_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  consumed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(device_id,nonce)
);
CREATE INDEX proposed_owner_wss_enrollment_nonces_time_ix
  ON proposed_owner_wss_enrollment_nonces(consumed_at_ms);
