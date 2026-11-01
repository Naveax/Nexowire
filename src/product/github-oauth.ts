import type {
  ControlPlaneIdentity,
  ControlPlaneService,
} from './control-plane-service.js';
import { issueSessionToken, sessionCookie } from './control-plane-session.js';
import {
  beginGitHubOAuthBrowserState,
  clearGitHubOAuthBrowserCookie,
  consumeGitHubOAuthBrowserState,
  githubOAuthStateDigest,
  type GitHubOAuthStateConsumeStore,
} from './github-oauth-browser-state.js';

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  adminGitHubId?: string;
  fetchImpl?: typeof fetch;
  /** Required for atomic login-CSRF replay protection. No legacy fallback. */
  stateConsumeStore?: GitHubOAuthStateConsumeStore;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

function requireConfig(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(name + ' is required.');
  return normalized;
}

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  return url.origin + '/auth/github/callback';
}

export async function githubOAuthStart(
  request: Request,
  config: GitHubOAuthConfig,
): Promise<Response> {
  const clientId = requireConfig(config.clientId, 'GitHub client ID');
  const sessionSecret = requireConfig(
    config.sessionSecret,
    'Session secret',
  );
  const requestUrl = new URL(request.url);
  // Never issue a login redirect until the cross-Worker state replay store
  // is configured. Existing production Worker wiring must be separately
  // reviewed/provisioned before this source change can be deployed.
  if (!config.stateConsumeStore) throw new Error('OAUTH_STATE_STORE_UNAVAILABLE');
  const issuedAt = new Date();
  const { state, cookie } = beginGitHubOAuthBrowserState(
    request.url, requestUrl.searchParams.get('next'), sessionSecret, issuedAt,
  );
  const now = Math.floor(issuedAt.getTime() / 1000);
  const issued = await config.stateConsumeStore.issue(
    githubOAuthStateDigest(state), now + 600, now,
  );
  if (!issued) throw new Error('OAUTH_STATE_STORE_UNAVAILABLE');
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', callbackUrl(request));
  authorize.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}

export async function githubOAuthCallback(
  request: Request,
  service: ControlPlaneService,
  config: GitHubOAuthConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code')?.trim();
  const state = url.searchParams.get('state')?.trim();
  if (!code || !state) {
    return Response.json(
      { error: 'OAUTH_CALLBACK_INVALID' },
      { status: 400 },
    );
  }

  if (!config.stateConsumeStore) {
    return Response.json({ error: 'OAUTH_STATE_STORE_UNAVAILABLE' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  let verified: {next: string} | null;
  try {
    verified = await consumeGitHubOAuthBrowserState(
      request, state, config.sessionSecret, config.stateConsumeStore,
    );
  } catch {
    return Response.json({ error: 'OAUTH_STATE_STORE_UNAVAILABLE' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (!verified) {
    return Response.json(
      { error: 'OAUTH_STATE_INVALID' },
      { status: 400 },
    );
  }

  const fetcher = config.fetchImpl ?? fetch;
  const tokenResponse = await fetcher(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: requireConfig(config.clientId, 'GitHub client ID'),
        client_secret: requireConfig(
          config.clientSecret,
          'GitHub client secret',
        ),
        code,
        redirect_uri: callbackUrl(request),
      }),
    },
  );

  if (!tokenResponse.ok) {
    return Response.json(
      { error: 'GITHUB_TOKEN_EXCHANGE_FAILED' },
      { status: 502 },
    );
  }
  const tokenBody = await tokenResponse.json() as {
    access_token?: string;
    error?: string;
  };
  if (!tokenBody.access_token || tokenBody.error) {
    return Response.json(
      { error: 'GITHUB_TOKEN_EXCHANGE_FAILED' },
      { status: 502 },
    );
  }

  const userResponse = await fetcher('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + tokenBody.access_token,
      'user-agent': 'Nexowire-Control-Plane',
      'x-github-api-version': '2026-03-10',
    },
  });
  if (!userResponse.ok) {
    return Response.json(
      { error: 'GITHUB_IDENTITY_FAILED' },
      { status: 502 },
    );
  }

  const user = await userResponse.json() as GitHubUser;
  if (
    !Number.isInteger(user.id) ||
    !user.login ||
    typeof user.login !== 'string'
  ) {
    return Response.json(
      { error: 'GITHUB_IDENTITY_INVALID' },
      { status: 502 },
    );
  }

  const loggedIn = await service.loginExternalIdentity({
    provider: 'github',
    subject: String(user.id),
    displayName: user.name ?? user.login,
    email: user.email,
    admin:
      config.adminGitHubId !== undefined &&
      String(user.id) === config.adminGitHubId.trim(),
  });
  const role: ControlPlaneIdentity['role'] =
    loggedIn.account.admin ? 'admin' : 'user';
  const token = issueSessionToken(
    {
      accountId: loggedIn.account.id,
      role,
    },
    config.sessionSecret,
  );

  const response = new Response(null, {
    status: 302,
    headers: {
      location: verified.next,
      'cache-control': 'no-store',
    },
  });
  response.headers.append('set-cookie', sessionCookie(token));
  response.headers.append('set-cookie', clearGitHubOAuthBrowserCookie());
  return response;
}
