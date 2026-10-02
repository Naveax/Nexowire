CREATE TABLE IF NOT EXISTS external_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_account
  ON external_identities(account_id);
