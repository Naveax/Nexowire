-- Owner-scoped folders. Empty folders intentionally persist until owner deletion.
CREATE TABLE IF NOT EXISTS device_folders (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 48),
  created_at TEXT NOT NULL,
  UNIQUE(owner_account_id, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS idx_device_folders_owner ON device_folders(owner_account_id);

CREATE TABLE IF NOT EXISTS device_folder_assignments (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES device_folders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folder_assignments_folder ON device_folder_assignments(folder_id);
