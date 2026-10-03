import { timingSafeEqual } from 'node:crypto';
import { D1ControlPlaneStore } from '../dist/src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../dist/src/product/control-plane-service.js';
import { D1McpOAuthStore } from '../dist/src/product/d1-mcp-oauth-store.js';
import { McpOAuthService } from '../dist/src/product/mcp-oauth.js';
import { createMcpOAuthHttpHandler } from '../dist/src/product/mcp-oauth-http.js';
import { createControlPlaneHttpHandler } from '../dist/src/product/control-plane-http.js';
import {
  clearSessionCookie,
  sessionTokenFromRequest,
  verifySessionToken,
} from '../dist/src/product/control-plane-session.js';
import {
  githubOAuthCallback,
  githubOAuthStart,
} from '../dist/src/product/github-oauth.js';

function boundedCapacity(env) {
  const raw = Number(env.NEXOWIRE_FREE_CAPACITY_PERCENT ?? '0');
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(100, raw))
    : null;
}

function envValue(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(name + ' is not configured.');
  return value;
}

function safeSecretEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function oauthConfig(env) {
  return {
    clientId: envValue(env, 'GITHUB_CLIENT_ID'),
    clientSecret: envValue(env, 'GITHUB_CLIENT_SECRET'),
    sessionSecret: envValue(env, 'NEXOWIRE_SESSION_SECRET'),
    ...(String(env.NEXOWIRE_ADMIN_GITHUB_ID ?? '').trim()
      ? {
          adminGitHubId: String(
            env.NEXOWIRE_ADMIN_GITHUB_ID,
          ).trim(),
        }
      : {}),
  };
}

async function authenticate(request, env) {
  const authorization =
    request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (authorization.startsWith(prefix)) {
    const supplied = authorization.slice(prefix.length).trim();
    const expected = String(
      env.NEXOWIRE_INTERNAL_SERVICE_TOKEN ?? '',
    ).trim();
    if (
      expected &&
      supplied &&
      safeSecretEqual(supplied, expected)
    ) {
      return {
        accountId: 'internal-service',
        role: 'service',
      };
    }
  }

  const cookieToken = sessionTokenFromRequest(request);
  if (!cookieToken) return null;
  return verifySessionToken(
    cookieToken,
    envValue(env, 'NEXOWIRE_SESSION_SECRET'),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: false,
      });
    }

    const store = new D1ControlPlaneStore(env.DB);
    const service = new ControlPlaneService(store, {
      infrastructure: () => ({
        freeCapacityPercent: boundedCapacity(env),
        prepaidCapacityCredits: 0,
      }),
    });

    const oauthNeeded =
      url.pathname.startsWith('/oauth/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname ===
        '/api/v1/internal/mcp/authenticate';
    const oauth = oauthNeeded
      ? new McpOAuthService(
          new D1McpOAuthStore(env.DB),
          {
            issuer: url.origin,
            resource: envValue(
              env,
              'NEXOWIRE_MCP_RESOURCE_URL',
            ),
          },
        )
      : null;

    if (oauth) {
      const oauthHandler =
        createMcpOAuthHttpHandler(
          oauth,
          {
            authenticateSession: (req) =>
              authenticate(req, env),
            loginRedirect: (req) => {
              const target = new URL(req.url);
              const next =
                target.pathname + target.search;
              return (
                '/auth/github/start?next=' +
                encodeURIComponent(next)
              );
            },
          },
        );
      const oauthResponse =
        await oauthHandler(request);
      if (oauthResponse) return oauthResponse;
    }

    if (url.pathname === '/auth/github/start') {
      try {
        return githubOAuthStart(request, oauthConfig(env));
      } catch {
        return Response.json(
          { error: 'AUTH_NOT_CONFIGURED' },
          { status: 503 },
        );
      }
    }

    if (url.pathname === '/auth/github/callback') {
      try {
        return await githubOAuthCallback(
          request,
          service,
          oauthConfig(env),
        );
      } catch {
        return Response.json(
          { error: 'AUTH_CALLBACK_FAILED' },
          { status: 502 },
        );
      }
    }

    if (url.pathname === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': clearSessionCookie(),
          'cache-control': 'no-store',
        },
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname ===
        '/api/v1/internal/mcp/authenticate'
    ) {
      const caller = await authenticate(request, env);
      if (!caller || caller.role !== 'service') {
        return Response.json(
          { error: 'SERVICE_REQUIRED' },
          { status: 403 },
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { error: 'INVALID_REQUEST' },
          { status: 400 },
        );
      }
      const accessToken =
        typeof body?.accessToken === 'string'
          ? body.accessToken
          : '';
      if (!oauth) {
        return Response.json(
          { error: 'OAUTH_NOT_CONFIGURED' },
          { status: 503 },
        );
      }
      const tokenIdentity =
        await oauth.authenticateAccessToken(
          accessToken,
        );
      if (!tokenIdentity) {
        return Response.json({
          authenticated: false,
        });
      }

      const account = await store.getAccount(
        tokenIdentity.accountId,
      );
      if (!account) {
        return Response.json({
          authenticated: false,
        });
      }

      const devices = await store.listDevices(account.id);

      return Response.json({
        authenticated: true,
        accountId: account.id,
        role: account.admin ? 'admin' : 'user',
        scopes: tokenIdentity.scopes,
        allowedDeviceIds: devices.map(
          (device) => device.id,
        ),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      const agentUrl = String(
        env.NEXOWIRE_AGENT_WS_URL ?? '',
      ).trim();
      const handler = createControlPlaneHttpHandler(service, {
        authenticate: (req) => authenticate(req, env),
        ...(agentUrl ? { agentUrl } : {}),
      });
      return handler(request);
    }

    return env.ASSETS.fetch(request);
  },
};
