import {
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { D1ControlPlaneStore } from '../dist/src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../dist/src/product/control-plane-service.js';
import { D1McpOAuthStore } from '../dist/src/product/d1-mcp-oauth-store.js';
import { McpOAuthService } from '../dist/src/product/mcp-oauth.js';
import { createMcpOAuthHttpHandler } from '../dist/src/product/mcp-oauth-http.js';
import { createControlPlaneHttpHandler } from '../dist/src/product/control-plane-http.js';
import {
  clearSessionCookie,
  issueOAuthState,
  sessionTokenFromRequest,
  verifyOAuthState,
  verifySessionToken,
} from '../dist/src/product/control-plane-session.js';
import {
  githubOAuthCallback,
  githubOAuthStart,
} from '../dist/src/product/github-oauth.js';
import {
  D1EncryptedRuntimeConfigStore,
  decryptRuntimeConfig,
  encryptRuntimeConfig,
} from '../dist/src/product/encrypted-runtime-config.js';
import {
  buildGitHubAppManifest,
  exchangeGitHubAppManifestCode,
} from '../dist/src/product/github-app-manifest.js';

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

const GITHUB_RUNTIME_CONFIG_KEY = 'github-oauth';

function optionalEnvValue(env, name) {
  const value = String(env[name] ?? '').trim();
  return value || undefined;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function storedGitHubOAuthCredentials(env, db) {
  const clientId = optionalEnvValue(
    env,
    'GITHUB_CLIENT_ID',
  );
  const clientSecret = optionalEnvValue(
    env,
    'GITHUB_CLIENT_SECRET',
  );

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error(
        'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together.',
      );
    }
    return {
      clientId,
      clientSecret,
      source: 'environment',
    };
  }

  const encrypted =
    await new D1EncryptedRuntimeConfigStore(db).get(
      GITHUB_RUNTIME_CONFIG_KEY,
    );
  if (!encrypted) return null;

  const config = decryptRuntimeConfig(
    encrypted,
    envValue(
      env,
      'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
    ),
  );
  if (
    typeof config !== 'object' ||
    config === null ||
    typeof config.clientId !== 'string' ||
    !config.clientId.trim() ||
    typeof config.clientSecret !== 'string' ||
    !config.clientSecret.trim()
  ) {
    throw new Error(
      'Stored GitHub OAuth configuration is invalid.',
    );
  }

  return {
    clientId: config.clientId.trim(),
    clientSecret: config.clientSecret.trim(),
    source: 'encrypted-d1',
  };
}

async function oauthConfig(env, db) {
  const credentials =
    await storedGitHubOAuthCredentials(env, db);
  if (!credentials) {
    throw new Error(
      'GitHub OAuth is not configured.',
    );
  }
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    sessionSecret: envValue(
      env,
      'NEXOWIRE_SESSION_SECRET',
    ),
    ...(String(env.NEXOWIRE_ADMIN_GITHUB_ID ?? '').trim()
      ? {
          adminGitHubId: String(
            env.NEXOWIRE_ADMIN_GITHUB_ID,
          ).trim(),
        }
      : {}),
  };
}

function githubManifestSetupPage(input) {
  const manifestJson = JSON.stringify(input.manifest);
  const action =
    'https://github.com/settings/apps/new?state=' +
    encodeURIComponent(input.state);
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Nexowire GitHub kurulumu</title></head>' +
      '<body style="font-family:system-ui;max-width:720px;margin:48px auto;padding:0 20px">' +
      '<h1>Nexowire GitHub girişini etkinleştir</h1>' +
      '<p>GitHub yalnız kullanıcı kimliği için kullanılacak. Repo erişimi istenmez.</p>' +
      '<form method="post" action="' +
      escapeHtml(action) +
      '">' +
      '<input type="hidden" name="manifest" value="' +
      escapeHtml(manifestJson) +
      '">' +
      '<button type="submit" style="font-size:18px;padding:12px 20px">GitHub App oluştur</button>' +
      '</form></body></html>',
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

function githubManifestCompletePage(slug) {
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Nexowire hazır</title></head>' +
      '<body style="font-family:system-ui;max-width:720px;margin:48px auto;padding:0 20px">' +
      '<h1>GitHub girişi hazır</h1>' +
      '<p>GitHub App güvenli şekilde bağlandı: <strong>' +
      escapeHtml(slug) +
      '</strong>.</p>' +
      '<p><a href="/">Nexowire paneline dön</a></p>' +
      '</body></html>',
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
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
    const runtimeConfigStore =
      new D1EncryptedRuntimeConfigStore(env.DB);
    const service = new ControlPlaneService(store, {
      infrastructure: () => ({
        freeCapacityPercent: boundedCapacity(env),
        prepaidCapacityCredits: 0,
      }),
    });

    if (
      request.method === 'POST' &&
      url.pathname ===
        '/api/v1/internal/setup/github/start'
    ) {
      const caller = await authenticate(request, env);
      if (!caller || caller.role !== 'service') {
        return Response.json(
          { error: 'SERVICE_REQUIRED' },
          { status: 403 },
        );
      }

      const configured =
        await storedGitHubOAuthCredentials(
          env,
          env.DB,
        );
      if (configured) {
        return Response.json({
          configured: true,
          source: configured.source,
        });
      }

      envValue(
        env,
        'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
      );
      const state = issueOAuthState(
        'github-app-manifest',
        '/',
        envValue(env, 'NEXOWIRE_SESSION_SECRET'),
        { ttlSeconds: 10 * 60 },
      );
      return Response.json({
        configured: false,
        setupUrl:
          url.origin +
          '/setup/github?state=' +
          encodeURIComponent(state),
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname ===
        '/api/v1/internal/setup/status'
    ) {
      const caller = await authenticate(request, env);
      if (!caller || caller.role !== 'service') {
        return Response.json(
          { error: 'SERVICE_REQUIRED' },
          { status: 403 },
        );
      }
      const configured =
        await storedGitHubOAuthCredentials(
          env,
          env.DB,
        );
      return Response.json({
        githubConfigured: Boolean(configured),
        source: configured?.source ?? null,
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/setup/github'
    ) {
      const configured =
        await storedGitHubOAuthCredentials(
          env,
          env.DB,
        );
      if (configured) {
        return Response.json(
          { error: 'SETUP_ALREADY_CONFIGURED' },
          { status: 409 },
        );
      }

      const state = url.searchParams.get('state') ?? '';
      const verified = verifyOAuthState(
        state,
        'github-app-manifest',
        envValue(env, 'NEXOWIRE_SESSION_SECRET'),
      );
      if (!verified) {
        return Response.json(
          { error: 'SETUP_STATE_INVALID' },
          { status: 403 },
        );
      }

      const manifest = buildGitHubAppManifest({
        origin: url.origin + '/',
        suggestedName:
          'Nexowire-' +
          randomBytes(4).toString('hex'),
      });
      return githubManifestSetupPage({
        state,
        manifest,
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/setup/github/callback'
    ) {
      const configured =
        await storedGitHubOAuthCredentials(
          env,
          env.DB,
        );
      if (configured) {
        return Response.json(
          { error: 'SETUP_ALREADY_CONFIGURED' },
          { status: 409 },
        );
      }

      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const verified = verifyOAuthState(
        state,
        'github-app-manifest',
        envValue(env, 'NEXOWIRE_SESSION_SECRET'),
      );
      if (!verified || !code) {
        return Response.json(
          { error: 'SETUP_CALLBACK_INVALID' },
          { status: 400 },
        );
      }

      try {
        const credentials =
          await exchangeGitHubAppManifestCode(code);
        const encrypted = encryptRuntimeConfig(
          {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
          },
          envValue(
            env,
            'NEXOWIRE_CONFIG_ENCRYPTION_KEY',
          ),
        );
        await runtimeConfigStore.put(
          GITHUB_RUNTIME_CONFIG_KEY,
          encrypted,
          new Date().toISOString(),
        );
        return githubManifestCompletePage(
          credentials.slug,
        );
      } catch {
        return Response.json(
          { error: 'GITHUB_APP_SETUP_FAILED' },
          { status: 502 },
        );
      }
    }

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
        return githubOAuthStart(
          request,
          await oauthConfig(env, env.DB),
        );
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
          await oauthConfig(env, env.DB),
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
