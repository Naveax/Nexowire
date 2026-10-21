-- SOURCE ONLY: explicit, authorized migration after #614 witness enrollment.
-- PostgreSQL tables reside on a rollback-external, independently attested host.
-- No service, privilege or local Agent mutation is performed by this file.
BEGIN;
CREATE TABLE IF NOT EXISTS witness_delegations (
  device_id UUID PRIMARY KEY REFERENCES witness_devices(device_id),
  owner_id UUID NOT NULL,
  epoch UUID NOT NULL,
  session_epoch UUID NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>=1),
  core_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  root_expires_ms BIGINT,
  max_seen_ms BIGINT NOT NULL CHECK(max_seen_ms>=0),
  CONSTRAINT positive_root_expiry CHECK(root_expires_ms IS NULL OR root_expires_ms>0)
);
-- Do NOT automatically import old CORE/ROOT preferences as effective grants.
-- Only separately signed owner approval with exact generation may bind them.
COMMIT;
