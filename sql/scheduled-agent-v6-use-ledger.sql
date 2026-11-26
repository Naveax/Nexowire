-- Provision once in a NEW dedicated off-host authority store, never Agent/Hub.
-- The independent provisioner inserts authority/store and public-key pins.
-- WAL/FULL and uniqueness are not restore protection. No reset/reissue API.
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
BEGIN IMMEDIATE;
PRAGMA application_id=1314406722;
PRAGMA user_version=1;
CREATE TABLE scheduled_v6_metadata(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  authority_id TEXT NOT NULL,store_id TEXT NOT NULL,
  forward_pin TEXT NOT NULL CHECK(length(forward_pin)=64),
  release_pin TEXT NOT NULL CHECK(length(release_pin)=64 AND release_pin<>forward_pin),
  max_seen_ms INTEGER NOT NULL DEFAULT 0 CHECK(max_seen_ms>=0)
) STRICT;
CREATE TABLE scheduled_v6_uses(
  attempt_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,installation_id TEXT NOT NULL,
  task_key TEXT NOT NULL CHECK(task_key IN ('nexowire prelogin agent','nexowire native agent')),
  fence_generation INTEGER NOT NULL CHECK(fence_generation>0),
  boot_epoch TEXT NOT NULL,binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  forward_sha256 TEXT NOT NULL UNIQUE CHECK(length(forward_sha256)=64),
  forward_consumed_at_ms INTEGER NOT NULL CHECK(forward_consumed_at_ms>0),
  forward_expires_at_ms INTEGER NOT NULL CHECK(forward_expires_at_ms>forward_consumed_at_ms AND forward_expires_at_ms-forward_consumed_at_ms<=300000),
  state TEXT NOT NULL CHECK(state IN ('FORWARD_CONSUMED','RELEASE_CONSUMED')),
  release_sha256 TEXT UNIQUE CHECK(release_sha256 IS NULL OR length(release_sha256)=64),
  assignment_sha256 TEXT CHECK(assignment_sha256 IS NULL OR length(assignment_sha256)=64),
  release_consumed_at_ms INTEGER,
  UNIQUE(device_id,installation_id,task_key,fence_generation),
  CHECK((state='FORWARD_CONSUMED' AND release_sha256 IS NULL AND assignment_sha256 IS NULL AND release_consumed_at_ms IS NULL)
    OR (state='RELEASE_CONSUMED' AND release_sha256 IS NOT NULL AND assignment_sha256 IS NOT NULL AND release_consumed_at_ms IS NOT NULL
        AND release_consumed_at_ms>=forward_consumed_at_ms AND release_consumed_at_ms<forward_expires_at_ms))
) STRICT;
COMMIT;
