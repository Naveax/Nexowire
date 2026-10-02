import type {
  ControlPlaneIdentity,
} from './control-plane-service.js';
import { ControlPlaneService } from './control-plane-service.js';

export interface ControlPlaneHttpOptions {
  authenticate(
    request: Request,
  ): Promise<ControlPlaneIdentity | null>;
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

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('JSON_REQUIRED');
  }
  const value = await request.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('JSON_OBJECT_REQUIRED');
  }
  return value as Record<string, unknown>;
}

function stringField(
  input: Record<string, unknown>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('INVALID_' + name.toUpperCase());
  }
  return value;
}

function errorStatus(message: string): number {
  if (
    message === 'ACCOUNT_NOT_FOUND' ||
    message === 'PAIRING_NOT_FOUND'
  ) return 404;
  if (
    message === 'ADMIN_REQUIRED' ||
    message === 'DEVICE_LIMIT_REACHED'
  ) return 403;
  if (message.startsWith('PAIRING_')) return 409;
  if (
    message.startsWith('INVALID_') ||
    message === 'JSON_REQUIRED' ||
    message === 'JSON_OBJECT_REQUIRED'
  ) return 400;
  return 500;
}

export function createControlPlaneHttpHandler(
  service: ControlPlaneService,
  options: ControlPlaneHttpOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        request.method === 'POST' &&
        path === '/api/v1/pairing/consume'
      ) {
        const body = await readJsonObject(request);
        const result = await service.consumePairing({
          pairingId: stringField(body, 'pairingId'),
          token: stringField(body, 'token'),
          platform: stringField(body, 'platform'),
          deviceAnchorHash: stringField(
            body,
            'deviceAnchorHash',
          ),
        });
        return json(200, result);
      }

      const identity = await options.authenticate(request);
      if (!identity) {
        return json(401, { error: 'UNAUTHENTICATED' });
      }

      if (
        request.method === 'GET' &&
        path === '/api/v1/me/dashboard'
      ) {
        return json(200, await service.dashboard(identity));
      }

      if (
        request.method === 'GET' &&
        path === '/api/v1/admin/overview'
      ) {
        return json(200, await service.adminOverview(identity));
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/pairing'
      ) {
        const body = await readJsonObject(request);
        return json(
          201,
          await service.beginPairing(
            identity,
            stringField(body, 'deviceName'),
          ),
        );
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/internal/usage/charge'
      ) {
        if (identity.role !== 'service') {
          return json(403, { error: 'SERVICE_REQUIRED' });
        }
        const body = await readJsonObject(request);
        return json(
          200,
          await service.chargeUsage({
            accountId: stringField(body, 'accountId'),
            eventId: stringField(body, 'eventId'),
            toolName: stringField(body, 'toolName'),
            ...(typeof body.baseCredits === 'number'
              ? { baseCredits: body.baseCredits }
              : {}),
          }),
        );
      }

      return json(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return json(errorStatus(message), {
        error:
          errorStatus(message) === 500
            ? 'INTERNAL_ERROR'
            : message,
      });
    }
  };
}
