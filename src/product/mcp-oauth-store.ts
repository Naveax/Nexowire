export interface McpOAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: 'none';
  createdAt: string;
}

export interface McpAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  accountId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface McpAccessTokenRecord {
  tokenHash: string;
  clientId: string;
  accountId: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
}

export interface McpRefreshTokenRecord {
  tokenHash: string;
  clientId: string;
  accountId: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface McpOAuthStore {
  getClient(clientId: string): Promise<McpOAuthClientRecord | null>;
  putClient(record: McpOAuthClientRecord): Promise<void>;

  getAuthorizationCode(
    codeHash: string,
  ): Promise<McpAuthorizationCodeRecord | null>;
  putAuthorizationCode(
    record: McpAuthorizationCodeRecord,
  ): Promise<void>;
  consumeAuthorizationCode(
    codeHash: string,
    consumedAt: string,
  ): Promise<boolean>;

  getAccessToken(
    tokenHash: string,
  ): Promise<McpAccessTokenRecord | null>;
  putAccessToken(
    record: McpAccessTokenRecord,
  ): Promise<void>;

  getRefreshToken(
    tokenHash: string,
  ): Promise<McpRefreshTokenRecord | null>;
  putRefreshToken(
    record: McpRefreshTokenRecord,
  ): Promise<void>;
  consumeRefreshToken(
    tokenHash: string,
    revokedAt: string,
  ): Promise<boolean>;

  pruneExpired(nowIso: string): Promise<void>;
}
