import type {
  ControlPlaneIdentity,
} from './control-plane-service.js';
import {
  McpOAuthError,
  McpOAuthService,
} from './mcp-oauth.js';

export interface McpOAuthHttpOptions {
  authenticateSession(
    request: Request,
  ): Promise<ControlPlaneIdentity | null>;
  loginRedirect(request: Request): string;
}

function json(
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function oauthError(error: unknown): Response {
  if (error instanceof McpOAuthError) {
    return json(400, {
      error: error.code,
      error_description: error.message,
    });
  }
  return json(500, {
    error: 'server_error',
  });
}

async function jsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const type =
    request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!type.includes('application/json')) {
    throw new McpOAuthError(
      'invalid_request',
      'application/json is required.',
    );
  }
  const value = await request.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new McpOAuthError(
      'invalid_request',
      'JSON object is required.',
    );
  }
  return value as Record<string, unknown>;
}

async function formBody(
  request: Request,
): Promise<URLSearchParams> {
  const type =
    request.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    !type.includes(
      'application/x-www-form-urlencoded',
    )
  ) {
    throw new McpOAuthError(
      'invalid_request',
      'application/x-www-form-urlencoded is required.',
    );
  }
  return new URLSearchParams(await request.text());
}

export function createMcpOAuthHttpHandler(
  oauth: McpOAuthService,
  options: McpOAuthHttpOptions,
): (request: Request) => Promise<Response | null> {
  return async (
    request: Request,
  ): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        request.method === 'GET' &&
        (
          path === '/.well-known/oauth-protected-resource' ||
          path === '/.well-known/oauth-protected-resource/mcp'
        )
      ) {
        return json(
          200,
          oauth.protectedResourceMetadata(),
        );
      }

      if (
        request.method === 'GET' &&
        (
          path === '/.well-known/oauth-authorization-server' ||
          path === '/.well-known/openid-configuration'
        )
      ) {
        return json(
          200,
          oauth.authorizationServerMetadata(),
        );
      }

      if (
        request.method === 'POST' &&
        path === '/oauth/register'
      ) {
        const body = await jsonObject(request);
        return json(
          201,
          await oauth.registerClient({
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method:
              body.token_endpoint_auth_method,
          }),
        );
      }

      if (
        request.method === 'GET' &&
        path === '/oauth/authorize'
      ) {
        const identity =
          await options.authenticateSession(request);
        if (
          !identity ||
          identity.role === 'service'
        ) {
          return new Response(null, {
            status: 302,
            headers: {
              location: options.loginRedirect(request),
              'cache-control': 'no-store',
            },
          });
        }

        const redirect = await oauth.authorize(
          identity.accountId,
          url.searchParams,
        );
        return new Response(null, {
          status: 302,
          headers: {
            location: redirect,
            'cache-control': 'no-store',
          },
        });
      }

      if (
        request.method === 'POST' &&
        path === '/oauth/token'
      ) {
        return json(
          200,
          await oauth.token(
            await formBody(request),
          ),
        );
      }

      return null;
    } catch (error) {
      return oauthError(error);
    }
  };
}
