CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL
    CHECK (token_endpoint_auth_method = 'none'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL
    REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL
    REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry
  ON mcp_oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL
    REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL
    REFERENCES accounts(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_access_expiry
  ON mcp_oauth_access_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_access_account
  ON mcp_oauth_access_tokens(account_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL
    REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL
    REFERENCES accounts(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_expiry
  ON mcp_oauth_refresh_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_account
  ON mcp_oauth_refresh_tokens(account_id);
