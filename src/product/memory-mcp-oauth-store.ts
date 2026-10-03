import type {
  McpAccessTokenRecord,
  McpAuthorizationCodeRecord,
  McpOAuthClientRecord,
  McpOAuthStore,
  McpRefreshTokenRecord,
} from './mcp-oauth-store.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryMcpOAuthStore implements McpOAuthStore {
  private readonly clients =
    new Map<string, McpOAuthClientRecord>();
  private readonly codes =
    new Map<string, McpAuthorizationCodeRecord>();
  private readonly accessTokens =
    new Map<string, McpAccessTokenRecord>();
  private readonly refreshTokens =
    new Map<string, McpRefreshTokenRecord>();

  async getClient(
    clientId: string,
  ): Promise<McpOAuthClientRecord | null> {
    const value = this.clients.get(clientId);
    return value ? clone(value) : null;
  }

  async putClient(
    record: McpOAuthClientRecord,
  ): Promise<void> {
    this.clients.set(record.clientId, clone(record));
  }

  async getAuthorizationCode(
    codeHash: string,
  ): Promise<McpAuthorizationCodeRecord | null> {
    const value = this.codes.get(codeHash);
    return value ? clone(value) : null;
  }

  async putAuthorizationCode(
    record: McpAuthorizationCodeRecord,
  ): Promise<void> {
    this.codes.set(record.codeHash, clone(record));
  }

  async consumeAuthorizationCode(
    codeHash: string,
    consumedAt: string,
  ): Promise<boolean> {
    const value = this.codes.get(codeHash);
    if (!value || value.consumedAt !== null) return false;
    this.codes.set(codeHash, {
      ...value,
      consumedAt,
    });
    return true;
  }

  async getAccessToken(
    tokenHash: string,
  ): Promise<McpAccessTokenRecord | null> {
    const value = this.accessTokens.get(tokenHash);
    return value ? clone(value) : null;
  }

  async putAccessToken(
    record: McpAccessTokenRecord,
  ): Promise<void> {
    this.accessTokens.set(record.tokenHash, clone(record));
  }

  async getRefreshToken(
    tokenHash: string,
  ): Promise<McpRefreshTokenRecord | null> {
    const value = this.refreshTokens.get(tokenHash);
    return value ? clone(value) : null;
  }

  async putRefreshToken(
    record: McpRefreshTokenRecord,
  ): Promise<void> {
    this.refreshTokens.set(record.tokenHash, clone(record));
  }

  async consumeRefreshToken(
    tokenHash: string,
    revokedAt: string,
  ): Promise<boolean> {
    const value = this.refreshTokens.get(tokenHash);
    if (!value || value.revokedAt !== null) return false;
    this.refreshTokens.set(tokenHash, {
      ...value,
      revokedAt,
    });
    return true;
  }

  async pruneExpired(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    for (const [key, value] of this.codes) {
      if (Date.parse(value.expiresAt) <= now) {
        this.codes.delete(key);
      }
    }
    for (const [key, value] of this.accessTokens) {
      if (Date.parse(value.expiresAt) <= now) {
        this.accessTokens.delete(key);
      }
    }
    for (const [key, value] of this.refreshTokens) {
      if (
        Date.parse(value.expiresAt) <= now ||
        value.revokedAt !== null
      ) {
        this.refreshTokens.delete(key);
      }
    }
  }
}
