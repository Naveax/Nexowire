-- Missing row means AUTO selection is OFF. Owner-only API must authorize writes.
CREATE TABLE IF NOT EXISTS owner_device_selection_settings (
  owner_account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
