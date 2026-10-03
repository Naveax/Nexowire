import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  type StatementSync,
} from 'node:sqlite';
import {
  D1ControlPlaneStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import { D1McpOAuthStore } from '../src/product/d1-mcp-oauth-store.js';
import {
  D1EncryptedRuntimeConfigStore,
  decryptRuntimeConfig,
  encryptRuntimeConfig,
} from '../src/product/encrypted-runtime-config.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { McpOAuthService } from '../src/product/mcp-oauth.js';

class SqliteD1Statement implements D1PreparedStatementLike {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteD1Statement(this.statement, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement.get(
      ...(this.values as Parameters<StatementSync['get']>),
    );
    return (row ?? null) as T | null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    return {
      success: true,
      results: this.statement.all(
        ...(this.values as Parameters<StatementSync['all']>),
      ) as T[],
    };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    const result = this.statement.run(
      ...(this.values as Parameters<StatementSync['run']>),
    );
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this.db.prepare(sql));
  }

  async batch(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike[]> {
    this.db.exec('BEGIN');
    try {
      const results: D1ResultLike[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(db: DatabaseSync): void {
  for (const name of [
    '0001_control_plane.sql',
    '0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql',
    '0004_device_credential_lookup.sql',
    '0005_mcp_oauth.sql',
    '0006_runtime_config.sql',
  ]) {
    db.exec(
      readFileSync(
        path.join(
          process.cwd(),
          'cloudflare',
          'migrations',
          name,
        ),
        'utf8',
      ),
    );
  }
}

test('D1 persists MCP OAuth registration, PKCE code and token rotation', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const control = new ControlPlaneService(
      new D1ControlPlaneStore(adapter),
      {
        now: () =>
          new Date('2026-10-03T00:00:00.000Z'),
      },
    );
    const account = await control.ensureAccount({
      id: 'oauth-account',
    });

    const oauth = new McpOAuthService(
      new D1McpOAuthStore(adapter),
      {
        issuer: 'https://auth.example.test',
        resource: 'https://mcp.example.test/mcp',
        now: () =>
          new Date('2026-10-03T00:00:00.000Z'),
      },
    );
    const registration =
      await oauth.registerClient({
        redirect_uris: [
          'https://chatgpt.com/oauth/callback/test',
        ],
        token_endpoint_auth_method: 'none',
      }) as { client_id: string };

    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    const codeChallenge = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');

    const redirect = new URL(
      await oauth.authorize(
        account.id,
        new URLSearchParams({
          response_type: 'code',
          client_id: registration.client_id,
          redirect_uri:
            'https://chatgpt.com/oauth/callback/test',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          resource:
            'https://mcp.example.test/mcp',
          scope: 'mcp offline_access',
        }),
      ),
    );

    const tokens = await oauth.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        client_id: registration.client_id,
        redirect_uri:
          'https://chatgpt.com/oauth/callback/test',
        code_verifier: verifier,
        resource: 'https://mcp.example.test/mcp',
      }),
    );

    const identity =
      await oauth.authenticateAccessToken(
        tokens.access_token,
      );
    assert.equal(identity?.accountId, account.id);

    const rotated = await oauth.token(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        client_id: registration.client_id,
        resource: 'https://mcp.example.test/mcp',
      }),
    );
    assert.notEqual(
      rotated.refresh_token,
      tokens.refresh_token,
    );

    const rows = db
      .prepare(
        'SELECT COUNT(*) AS count FROM mcp_oauth_access_tokens',
      )
      .get() as { count: number };
    assert.equal(Number(rows.count), 2);
  } finally {
    db.close();
  }
});


test('D1 stores only encrypted runtime config and decrypts with the matching key', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const store =
      new D1EncryptedRuntimeConfigStore(adapter);
    const key = Buffer.alloc(32, 7).toString('base64url');
    const encrypted = encryptRuntimeConfig(
      {
        clientId: 'Iv1.test-client',
        clientSecret: 'github-secret-must-not-appear',
      },
      key,
    );

    assert.equal(
      encrypted.includes(
        'github-secret-must-not-appear',
      ),
      false,
    );

    await store.put(
      'github-oauth',
      encrypted,
      '2026-10-03T00:00:00.000Z',
    );

    const stored = await store.get('github-oauth');
    assert.ok(stored);
    assert.deepEqual(
      decryptRuntimeConfig(stored!, key),
      {
        clientId: 'Iv1.test-client',
        clientSecret: 'github-secret-must-not-appear',
      },
    );

    assert.throws(
      () =>
        decryptRuntimeConfig(
          stored!,
          Buffer.alloc(32, 8).toString('base64url'),
        ),
    );
  } finally {
    db.close();
  }
});
