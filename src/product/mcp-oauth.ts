import {
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  McpOAuthClientRecord,
  McpOAuthStore,
} from './mcp-oauth-store.js';

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const ALLOWED_SCOPES = new Set([
  'mcp',
  'offline_access',
]);

export class McpOAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'unsupported_response_type'
      | 'invalid_scope',
    message: string,
  ) {
    super(message);
  }
}

export interface McpOAuthServiceOptions {
  issuer: string;
  resource: string;
  now?: () => Date;
}

export interface McpOAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export interface McpAccessIdentity {
  accountId: string;
  clientId: string;
  resource: string;
  scopes: string[];
}

function normalizeHttpsUrl(
  input: string,
  name: string,
  options: {
    allowLoopbackHttp?: boolean;
    allowPath?: boolean;
  } = {},
): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(name + ' is invalid.');
  }

  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]';

  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        options.allowLoopbackHttp === true &&
        loopback &&
        url.protocol === 'http:'
      ))
  ) {
    throw new Error(name + ' must be a secure URL.');
  }

  if (options.allowPath !== true) {
    url.pathname = '/';
    url.search = '';
  }

  return url.toString().replace(/\/$/, '');
}

function normalizeRedirectUri(input: string): string {
  const value = normalizeHttpsUrl(
    input,
    'OAuth redirect URI',
    {
      allowLoopbackHttp: true,
      allowPath: true,
    },
  );
  const url = new URL(value);
  if (url.hash) {
    throw new McpOAuthError(
      'invalid_request',
      'OAuth redirect URI must not contain a fragment.',
    );
  }
  return url.toString();
}

function tokenHash(token: string): string {
  return createHash('sha256')
    .update(token, 'utf8')
    .digest('hex');
}

function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
}

function requirePkceVerifier(input: string | null): string {
  const value = input?.trim() ?? '';
  if (
    value.length < 43 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new McpOAuthError(
      'invalid_grant',
      'PKCE code_verifier is invalid.',
    );
  }
  return value;
}

function requirePkceChallenge(input: string | null): string {
  const value = input?.trim() ?? '';
  if (
    value.length < 43 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new McpOAuthError(
      'invalid_request',
      'PKCE code_challenge is invalid.',
    );
  }
  return value;
}

function parseScopes(input: string | null): string[] {
  const values = [
    ...new Set(
      (input?.trim() || 'mcp')
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  if (
    !values.includes('mcp') ||
    values.some((scope) => !ALLOWED_SCOPES.has(scope))
  ) {
    throw new McpOAuthError(
      'invalid_scope',
      'Requested OAuth scope is not supported.',
    );
  }
  return values;
}

function requireClientId(input: string | null): string {
  const value = input?.trim() ?? '';
  if (
    !value ||
    value.length > 512 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new McpOAuthError(
      'invalid_client',
      'OAuth client_id is invalid.',
    );
  }
  return value;
}

function requireResource(
  input: string | null,
  expected: string,
): string {
  if (!input) {
    throw new McpOAuthError(
      'invalid_request',
      'OAuth resource is required.',
    );
  }
  let normalized: string;
  try {
    normalized = normalizeHttpsUrl(
      input,
      'OAuth resource',
      {
        allowLoopbackHttp: true,
        allowPath: true,
      },
    );
  } catch {
    throw new McpOAuthError(
      'invalid_request',
      'OAuth resource is invalid.',
    );
  }
  if (normalized !== expected) {
    throw new McpOAuthError(
      'invalid_request',
      'OAuth resource does not match the Nexowire MCP resource.',
    );
  }
  return normalized;
}

function isoAfter(now: Date, seconds: number): string {
  return new Date(
    now.getTime() + seconds * 1000,
  ).toISOString();
}

export class McpOAuthService {
  readonly issuer: string;
  readonly resource: string;
  private readonly now: () => Date;

  constructor(
    private readonly store: McpOAuthStore,
    options: McpOAuthServiceOptions,
  ) {
    this.issuer = normalizeHttpsUrl(
      options.issuer,
      'OAuth issuer',
      { allowLoopbackHttp: true },
    );
    this.resource = normalizeHttpsUrl(
      options.resource,
      'OAuth resource',
      {
        allowLoopbackHttp: true,
        allowPath: true,
      },
    );
    this.now = options.now ?? (() => new Date());
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ['mcp', 'offline_access'],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint:
        this.issuer + '/oauth/authorize',
      token_endpoint:
        this.issuer + '/oauth/token',
      registration_endpoint:
        this.issuer + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
      ],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp', 'offline_access'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: false,
    };
  }

  async registerClient(input: {
    redirect_uris?: unknown;
    token_endpoint_auth_method?: unknown;
  }): Promise<Record<string, unknown>> {
    if (
      !Array.isArray(input.redirect_uris) ||
      input.redirect_uris.length < 1 ||
      input.redirect_uris.length > 10 ||
      input.redirect_uris.some(
        (value) => typeof value !== 'string',
      )
    ) {
      throw new McpOAuthError(
        'invalid_request',
        'redirect_uris must contain 1-10 URLs.',
      );
    }

    if (
      input.token_endpoint_auth_method !== undefined &&
      input.token_endpoint_auth_method !== 'none'
    ) {
      throw new McpOAuthError(
        'invalid_client',
        'Only public PKCE OAuth clients are supported.',
      );
    }

    const redirectUris = [
      ...new Set(
        (input.redirect_uris as string[]).map(
          normalizeRedirectUri,
        ),
      ),
    ];
    const record: McpOAuthClientRecord = {
      clientId:
        'nwx_oauth_client_' +
        randomBytes(18).toString('base64url'),
      redirectUris,
      tokenEndpointAuthMethod: 'none',
      createdAt: this.now().toISOString(),
    };
    await this.store.putClient(record);

    return {
      client_id: record.clientId,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: [
        'authorization_code',
        'refresh_token',
      ],
      response_types: ['code'],
    };
  }

  async authorize(
    accountId: string,
    params: URLSearchParams,
  ): Promise<string> {
    if (params.get('response_type') !== 'code') {
      throw new McpOAuthError(
        'unsupported_response_type',
        'Only response_type=code is supported.',
      );
    }

    const clientId = requireClientId(
      params.get('client_id'),
    );
    const client = await this.store.getClient(clientId);
    if (!client) {
      throw new McpOAuthError(
        'invalid_client',
        'OAuth client is unknown.',
      );
    }

    const redirectRaw = params.get('redirect_uri');
    if (!redirectRaw) {
      throw new McpOAuthError(
        'invalid_request',
        'redirect_uri is required.',
      );
    }
    const redirectUri = normalizeRedirectUri(redirectRaw);
    if (!client.redirectUris.includes(redirectUri)) {
      throw new McpOAuthError(
        'invalid_request',
        'redirect_uri is not registered for this client.',
      );
    }

    if (params.get('code_challenge_method') !== 'S256') {
      throw new McpOAuthError(
        'invalid_request',
        'PKCE S256 is required.',
      );
    }
    const codeChallenge = requirePkceChallenge(
      params.get('code_challenge'),
    );
    const resource = requireResource(
      params.get('resource'),
      this.resource,
    );
    const scopes = parseScopes(params.get('scope'));
    const state = params.get('state');

    const now = this.now();
    const code = randomToken('nwx_code_');
    await this.store.putAuthorizationCode({
      codeHash: tokenHash(code),
      clientId,
      accountId,
      redirectUri,
      codeChallenge,
      resource,
      scopes,
      expiresAt: isoAfter(now, CODE_TTL_SECONDS),
      consumedAt: null,
      createdAt: now.toISOString(),
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    return target.toString();
  }

  async token(
    form: URLSearchParams,
  ): Promise<McpOAuthTokenResponse> {
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      return this.exchangeAuthorizationCode(form);
    }
    if (grantType === 'refresh_token') {
      return this.exchangeRefreshToken(form);
    }
    throw new McpOAuthError(
      'unsupported_grant_type',
      'OAuth grant_type is not supported.',
    );
  }

  async authenticateAccessToken(
    token: string,
  ): Promise<McpAccessIdentity | null> {
    const value = token.trim();
    if (
      !value.startsWith('nwx_mcp_') ||
      value.length > 512 ||
      /[\r\n\0]/.test(value)
    ) {
      return null;
    }

    const record = await this.store.getAccessToken(
      tokenHash(value),
    );
    if (
      !record ||
      record.resource !== this.resource ||
      !record.scopes.includes('mcp') ||
      Date.parse(record.expiresAt) <=
        this.now().getTime()
    ) {
      return null;
    }

    return {
      accountId: record.accountId,
      clientId: record.clientId,
      resource: record.resource,
      scopes: [...record.scopes],
    };
  }

  private async exchangeAuthorizationCode(
    form: URLSearchParams,
  ): Promise<McpOAuthTokenResponse> {
    const code = form.get('code')?.trim() ?? '';
    if (!code.startsWith('nwx_code_')) {
      throw new McpOAuthError(
        'invalid_grant',
        'Authorization code is invalid.',
      );
    }

    const record = await this.store.getAuthorizationCode(
      tokenHash(code),
    );
    if (
      !record ||
      record.consumedAt !== null ||
      Date.parse(record.expiresAt) <=
        this.now().getTime()
    ) {
      throw new McpOAuthError(
        'invalid_grant',
        'Authorization code is invalid or expired.',
      );
    }

    const clientId = requireClientId(
      form.get('client_id'),
    );
    const redirectRaw = form.get('redirect_uri');
    if (!redirectRaw) {
      throw new McpOAuthError(
        'invalid_grant',
        'redirect_uri is required.',
      );
    }
    const redirectUri = normalizeRedirectUri(redirectRaw);
    const resource = requireResource(
      form.get('resource'),
      this.resource,
    );
    const verifier = requirePkceVerifier(
      form.get('code_verifier'),
    );

    if (
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.resource !== resource ||
      pkceChallenge(verifier) !== record.codeChallenge
    ) {
      throw new McpOAuthError(
        'invalid_grant',
        'Authorization code binding validation failed.',
      );
    }

    const consumed =
      await this.store.consumeAuthorizationCode(
        record.codeHash,
        this.now().toISOString(),
      );
    if (!consumed) {
      throw new McpOAuthError(
        'invalid_grant',
        'Authorization code was already consumed.',
      );
    }

    return this.issueTokens({
      clientId: record.clientId,
      accountId: record.accountId,
      resource: record.resource,
      scopes: record.scopes,
    });
  }

  private async exchangeRefreshToken(
    form: URLSearchParams,
  ): Promise<McpOAuthTokenResponse> {
    const refreshToken =
      form.get('refresh_token')?.trim() ?? '';
    if (!refreshToken.startsWith('nwx_refresh_')) {
      throw new McpOAuthError(
        'invalid_grant',
        'Refresh token is invalid.',
      );
    }

    const record = await this.store.getRefreshToken(
      tokenHash(refreshToken),
    );
    if (
      !record ||
      record.revokedAt !== null ||
      Date.parse(record.expiresAt) <=
        this.now().getTime()
    ) {
      throw new McpOAuthError(
        'invalid_grant',
        'Refresh token is invalid or expired.',
      );
    }

    const clientId = requireClientId(
      form.get('client_id'),
    );
    const resource = requireResource(
      form.get('resource'),
      this.resource,
    );
    if (
      record.clientId !== clientId ||
      record.resource !== resource
    ) {
      throw new McpOAuthError(
        'invalid_grant',
        'Refresh token binding validation failed.',
      );
    }

    const consumed =
      await this.store.consumeRefreshToken(
        record.tokenHash,
        this.now().toISOString(),
      );
    if (!consumed) {
      throw new McpOAuthError(
        'invalid_grant',
        'Refresh token was already rotated.',
      );
    }

    return this.issueTokens({
      clientId: record.clientId,
      accountId: record.accountId,
      resource: record.resource,
      scopes: record.scopes,
    });
  }

  private async issueTokens(input: {
    clientId: string;
    accountId: string;
    resource: string;
    scopes: string[];
  }): Promise<McpOAuthTokenResponse> {
    const now = this.now();
    const accessToken = randomToken('nwx_mcp_');

    await this.store.putAccessToken({
      tokenHash: tokenHash(accessToken),
      clientId: input.clientId,
      accountId: input.accountId,
      resource: input.resource,
      scopes: [...input.scopes],
      expiresAt: isoAfter(
        now,
        ACCESS_TTL_SECONDS,
      ),
      createdAt: now.toISOString(),
    });

    let refreshToken: string | undefined;
    if (input.scopes.includes('offline_access')) {
      refreshToken = randomToken('nwx_refresh_');
      await this.store.putRefreshToken({
        tokenHash: tokenHash(refreshToken),
        clientId: input.clientId,
        accountId: input.accountId,
        resource: input.resource,
        scopes: [...input.scopes],
        expiresAt: isoAfter(
          now,
          REFRESH_TTL_SECONDS,
        ),
        revokedAt: null,
        createdAt: now.toISOString(),
      });
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope: input.scopes.join(' '),
      ...(refreshToken
        ? { refresh_token: refreshToken }
        : {}),
    };
  }
}
