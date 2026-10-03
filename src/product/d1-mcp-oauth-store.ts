import type {
  McpAccessTokenRecord,
  McpAuthorizationCodeRecord,
  McpOAuthClientRecord,
  McpOAuthStore,
  McpRefreshTokenRecord,
} from './mcp-oauth-store.js';
import type {
  D1DatabaseLike,
} from './d1-control-plane-store.js';

type ClientRow = {
  client_id: string;
  redirect_uris_json: string;
  token_endpoint_auth_method: 'none';
  created_at: string;
};

type CodeRow = {
  code_hash: string;
  client_id: string;
  account_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes_json: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type AccessRow = {
  token_hash: string;
  client_id: string;
  account_id: string;
  resource: string;
  scopes_json: string;
  expires_at: string;
  created_at: string;
};

type RefreshRow = AccessRow & {
  revoked_at: string | null;
};

function stringArray(
  raw: string,
  name: string,
): string[] {
  const value = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Stored ' + name + ' JSON is invalid.');
  }
  return value;
}

function clientFromRow(
  row: ClientRow,
): McpOAuthClientRecord {
  return {
    clientId: row.client_id,
    redirectUris: stringArray(
      row.redirect_uris_json,
      'OAuth redirect URI',
    ),
    tokenEndpointAuthMethod:
      row.token_endpoint_auth_method,
    createdAt: row.created_at,
  };
}

function codeFromRow(
  row: CodeRow,
): McpAuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    accountId: row.account_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scopes: stringArray(row.scopes_json, 'OAuth scope'),
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function accessFromRow(
  row: AccessRow,
): McpAccessTokenRecord {
  return {
    tokenHash: row.token_hash,
    clientId: row.client_id,
    accountId: row.account_id,
    resource: row.resource,
    scopes: stringArray(row.scopes_json, 'OAuth scope'),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function refreshFromRow(
  row: RefreshRow,
): McpRefreshTokenRecord {
  return {
    ...accessFromRow(row),
    revokedAt: row.revoked_at,
  };
}

export class D1McpOAuthStore implements McpOAuthStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getClient(
    clientId: string,
  ): Promise<McpOAuthClientRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT client_id, redirect_uris_json, token_endpoint_auth_method, created_at FROM mcp_oauth_clients WHERE client_id = ?',
      )
      .bind(clientId)
      .first<ClientRow>();
    return row ? clientFromRow(row) : null;
  }

  async putClient(
    record: McpOAuthClientRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_clients
          (client_id, redirect_uris_json, token_endpoint_auth_method, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           redirect_uris_json = excluded.redirect_uris_json,
           token_endpoint_auth_method = excluded.token_endpoint_auth_method`,
      )
      .bind(
        record.clientId,
        JSON.stringify(record.redirectUris),
        record.tokenEndpointAuthMethod,
        record.createdAt,
      )
      .run();
  }

  async getAuthorizationCode(
    codeHash: string,
  ): Promise<McpAuthorizationCodeRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT code_hash, client_id, account_id, redirect_uri, code_challenge, resource, scopes_json, expires_at, consumed_at, created_at FROM mcp_oauth_codes WHERE code_hash = ?',
      )
      .bind(codeHash)
      .first<CodeRow>();
    return row ? codeFromRow(row) : null;
  }

  async putAuthorizationCode(
    record: McpAuthorizationCodeRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_codes
          (code_hash, client_id, account_id, redirect_uri, code_challenge, resource, scopes_json, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.codeHash,
        record.clientId,
        record.accountId,
        record.redirectUri,
        record.codeChallenge,
        record.resource,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.consumedAt,
        record.createdAt,
      )
      .run();
  }

  async consumeAuthorizationCode(
    codeHash: string,
    consumedAt: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE mcp_oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL',
      )
      .bind(consumedAt, codeHash)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async getAccessToken(
    tokenHash: string,
  ): Promise<McpAccessTokenRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT token_hash, client_id, account_id, resource, scopes_json, expires_at, created_at FROM mcp_oauth_access_tokens WHERE token_hash = ?',
      )
      .bind(tokenHash)
      .first<AccessRow>();
    return row ? accessFromRow(row) : null;
  }

  async putAccessToken(
    record: McpAccessTokenRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_access_tokens
          (token_hash, client_id, account_id, resource, scopes_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.tokenHash,
        record.clientId,
        record.accountId,
        record.resource,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.createdAt,
      )
      .run();
  }

  async getRefreshToken(
    tokenHash: string,
  ): Promise<McpRefreshTokenRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT token_hash, client_id, account_id, resource, scopes_json, expires_at, created_at, revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash = ?',
      )
      .bind(tokenHash)
      .first<RefreshRow>();
    return row ? refreshFromRow(row) : null;
  }

  async putRefreshToken(
    record: McpRefreshTokenRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_refresh_tokens
          (token_hash, client_id, account_id, resource, scopes_json, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.tokenHash,
        record.clientId,
        record.accountId,
        record.resource,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.revokedAt,
        record.createdAt,
      )
      .run();
  }

  async consumeRefreshToken(
    tokenHash: string,
    revokedAt: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .bind(revokedAt, tokenHash)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async pruneExpired(nowIso: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          'DELETE FROM mcp_oauth_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL',
        )
        .bind(nowIso),
      this.db
        .prepare(
          'DELETE FROM mcp_oauth_access_tokens WHERE expires_at <= ?',
        )
        .bind(nowIso),
      this.db
        .prepare(
          'DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL',
        )
        .bind(nowIso),
    ]);
  }
}
