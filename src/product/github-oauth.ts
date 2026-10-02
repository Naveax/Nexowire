import type {
  ControlPlaneIdentity,
  ControlPlaneService,
} from './control-plane-service.js';
import {
  issueOAuthState,
  issueSessionToken,
  sessionCookie,
  verifyOAuthState,
} from './control-plane-session.js';

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  adminGitHubId?: string;
  fetchImpl?: typeof fetch;
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

export function githubOAuthStart(
  request: Request,
  config: GitHubOAuthConfig,
): Response {
  const clientId = requireConfig(config.clientId, 'GitHub client ID');
  const sessionSecret = requireConfig(
    config.sessionSecret,
    'Session secret',
  );
  const requestUrl = new URL(request.url);
  const state = issueOAuthState(
    'github',
    requestUrl.searchParams.get('next') ?? '/',
    sessionSecret,
  );
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', callbackUrl(request));
  authorize.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
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

  const verified = verifyOAuthState(
    state,
    'github',
    config.sessionSecret,
  );
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

  return new Response(null, {
    status: 302,
    headers: {
      location: verified.next,
      'set-cookie': sessionCookie(token),
      'cache-control': 'no-store',
    },
  });
}
