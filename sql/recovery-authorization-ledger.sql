-- Provision once in a NEW dedicated authority database, never a Hub ledger.
-- Set WAL and FULL before creating the schema. Insert the independently
-- provisioned authority/store UUIDs into metadata exactly once before use.
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
BEGIN IMMEDIATE;
PRAGMA application_id=1314406721;
PRAGMA user_version=1;
CREATE TABLE recovery_authority_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  authority_id TEXT NOT NULL,
  store_id TEXT NOT NULL
) STRICT;
CREATE TABLE recovery_authorization_uses (
  transaction_sha256 TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>reserved_at_ms AND expires_at_ms-reserved_at_ms<=30000),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','SEALED','CONSUMED')),
  envelope_sha256 TEXT UNIQUE,
  consumed_at_ms INTEGER,
  CHECK ((state='RESERVED' AND envelope_sha256 IS NULL AND consumed_at_ms IS NULL)
      OR (state='SEALED' AND envelope_sha256 IS NOT NULL AND consumed_at_ms IS NULL)
      OR (state='CONSUMED' AND envelope_sha256 IS NOT NULL AND consumed_at_ms IS NOT NULL
          AND consumed_at_ms>=reserved_at_ms AND consumed_at_ms<expires_at_ms))
) STRICT;
COMMIT;
