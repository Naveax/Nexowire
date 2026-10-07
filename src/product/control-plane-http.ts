import type {
  ControlPlaneIdentity,
} from './control-plane-service.js';
import { ControlPlaneService } from './control-plane-service.js';
import { PRODUCT_PLANS, type ProductFeature } from './plans.js';
import { quoteToolUsage } from './usage-policy.js';

export interface ControlPlaneHttpOptions {
  authenticate(
    request: Request,
  ): Promise<ControlPlaneIdentity | null>;
  agentUrl?: string;
}

function normalizeAgentUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Control-plane agent URL is invalid.');
  }

  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'wss:' &&
      !(loopback && url.protocol === 'ws:')) ||
    url.pathname !== '/agent' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Control-plane agent URL must be wss://.../agent (or loopback ws://.../agent for development).',
    );
  }
  return url.toString();
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

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  name: string,
): number | null | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1_000_000
  ) {
    throw new Error('INVALID_' + name.toUpperCase());
  }
  return value;
}

const CUSTOM_FEATURES = new Set<ProductFeature>([
  'private-pointer',
  'private-keyboard',
  'private-screen',
  'automation',
  'priority-routing',
]);

function optionalFeatureList(
  input: Record<string, unknown>,
): ProductFeature[] | undefined {
  const value = input.features;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CUSTOM_FEATURES.size) {
    throw new Error('INVALID_FEATURES');
  }
  const output: ProductFeature[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !CUSTOM_FEATURES.has(entry as ProductFeature) ||
      seen.has(entry)
    ) {
      throw new Error('INVALID_FEATURES');
    }
    seen.add(entry);
    output.push(entry as ProductFeature);
  }
  return output;
}

function errorStatus(message: string): number {
  if (message === 'BILLING_PAUSED') return 503;
  if (
    message === 'ACCOUNT_NOT_FOUND' ||
    message === 'PAIRING_NOT_FOUND' ||
    message === 'DEVICE_NOT_FOUND'
  ) return 404;
  if (
    message === 'ADMIN_REQUIRED' ||
    message === 'DEVICE_LIMIT_REACHED'
  ) return 403;
  if (
    message.startsWith('PAIRING_') ||
    message === 'DEVICE_ALREADY_BOUND'
  ) return 409;
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
  const configuredAgentUrl = options.agentUrl
    ? normalizeAgentUrl(options.agentUrl)
    : null;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        request.method === 'POST' &&
        path === '/api/v1/pairing/consume'
      ) {
        if (!configuredAgentUrl) {
          return json(503, {
            error: 'AGENT_ENDPOINT_UNAVAILABLE',
          });
        }
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
        return json(200, {
          ...result,
          agentUrl: configuredAgentUrl,
        });
      }

      // Safe unauthenticated introspection of public, account-independent
      // Free-plan limits. This exposes no identity, usage ledger or tokens.
      if (request.method === 'GET' && path === '/api/v1/public/usage-policy') {
        const freePlan = PRODUCT_PLANS.free;
        return json(200, {
          planId: freePlan.id,
          monthlyCredits: freePlan.monthlyCredits,
          normalToolCredits: quoteToolUsage(freePlan, 'machine_health').credits,
          specialSkillToolCredits: quoteToolUsage(freePlan, 'skill_read').credits,
          quotaPeriod: 'calendar-month-utc',
        });
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
        request.method === 'POST' &&
        path === '/api/v1/me/devices/access-mode'
      ) {
        const body = await readJsonObject(request);
        const mode = stringField(body, 'mode').trim().toLowerCase();
        if (
          mode === 'full' &&
          request.headers.get('x-nexowire-confirm') !== 'full-access-v1'
        ) {
          return json(400, {
            error: 'FULL_ACCESS_CONFIRMATION_REQUIRED',
          });
        }
        return json(
          200,
          await service.setDeviceAccessMode(
            identity,
            stringField(body, 'deviceId'),
            mode,
          ),
        );
      }

      if (
        request.method === 'GET' &&
        path === '/api/v1/admin/overview'
      ) {
        return json(200, await service.adminOverview(identity));
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/admin/accounts/custom-prepaid'
      ) {
        const body = await readJsonObject(request);
        return json(
          200,
          await service.configureCustomPrepaidPlan(
            identity,
            stringField(body, 'accountId'),
            {
              maxDevices: optionalPositiveIntegerField(
                body,
                'maxDevices',
              ),
              maxConcurrentTasks:
                optionalPositiveIntegerField(
                  body,
                  'maxConcurrentTasks',
                ),
              features: optionalFeatureList(body),
            },
          ),
        );
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
            typeof body.deviceId === 'string'
              ? body.deviceId
              : undefined,
          ),
        );
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/internal/device/authenticate'
      ) {
        if (identity.role !== 'service') {
          return json(403, { error: 'SERVICE_REQUIRED' });
        }
        const body = await readJsonObject(request);
        const device =
          await service.authenticateDeviceCredential(
            stringField(body, 'credential'),
          );
        return json(200, device
          ? { authenticated: true, device }
          : { authenticated: false });
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/internal/device/presence'
      ) {
        if (identity.role !== 'service') {
          return json(403, { error: 'SERVICE_REQUIRED' });
        }
        const body = await readJsonObject(request);
        if (typeof body.online !== 'boolean') {
          return json(400, { error: 'INVALID_REQUEST' });
        }
        const updated = await service.setDevicePresence(
          stringField(body, 'deviceId'),
          body.online,
          stringField(body, 'at'),
        );
        return updated
          ? json(200, { updated: true })
          : json(404, { error: 'DEVICE_NOT_FOUND' });
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/internal/usage/charge'
      ) {
        if (identity.role !== 'service') {
          return json(403, { error: 'SERVICE_REQUIRED' });
        }
        const body = await readJsonObject(request);
        if (body.specialSkill !== undefined && typeof body.specialSkill !== 'boolean') {
          throw new Error('INVALID_SPECIAL_SKILL');
        }
        return json(
          200,
          await service.chargeUsage({
            accountId: stringField(body, 'accountId'),
            eventId: stringField(body, 'eventId'),
            toolName: stringField(body, 'toolName'),
            ...(typeof body.baseCredits === 'number'
              ? { baseCredits: body.baseCredits }
              : {}),
            ...(body.specialSkill === true ? { specialSkill: true } : {}),
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
