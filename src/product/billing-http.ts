import type {
  ControlPlaneIdentity,
} from './control-plane-service.js';
import { BillingService } from './billing-service.js';

export interface BillingHttpOptions {
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
  const contentType =
    request.headers.get('content-type') ?? '';
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

function errorStatus(message: string): number {
  if (
    message === 'ACCOUNT_NOT_FOUND' ||
    message === 'BILLING_SUBSCRIPTION_NOT_FOUND'
  ) return 404;
  if (message === 'BILLING_WEBHOOK_SIGNATURE_INVALID') {
    return 401;
  }
  if (
    message === 'BILLING_PORTAL_REQUIRED' ||
    message === 'BILLING_ACCOUNT_MISMATCH' ||
    message === 'BILLING_CUSTOM_MANAGED' ||
    message === 'BILLING_PREPAID_REQUIRED' ||
    message === 'BILLING_PURCHASE_MISMATCH'
  ) return 409;
  if (message === 'BILLING_VARIANT_UNKNOWN') return 422;
  if (
    message === 'BILLING_PREPAID_PACKS_UNAVAILABLE' ||
    message === 'BILLING_PREPAID_PURCHASE_PENDING'
  ) {
    return 503;
  }
  if (
    message.startsWith('BILLING_WEBHOOK_INVALID') ||
    message === 'BILLING_PLAN_INVALID' ||
    message === 'JSON_REQUIRED' ||
    message === 'JSON_OBJECT_REQUIRED'
  ) return 400;
  if (message.startsWith('BILLING_PROVIDER_HTTP_')) {
    return 502;
  }
  return 500;
}

export function createBillingHttpHandler(
  service: BillingService,
  options: BillingHttpOptions,
): (request: Request) => Promise<Response | null> {
  return async (
    request: Request,
  ): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        request.method === 'POST' &&
        path === '/api/v1/billing/webhook/lemonsqueezy'
      ) {
        const signature =
          request.headers.get('x-signature') ?? '';
        const contentLength = Number(
          request.headers.get('content-length') ?? '0',
        );
        if (
          Number.isFinite(contentLength) &&
          contentLength > 262_144
        ) {
          return json(413, {
            error: 'BILLING_WEBHOOK_TOO_LARGE',
          });
        }
        const rawBody = await request.text();
        if (
          !rawBody ||
          !signature ||
          Buffer.byteLength(rawBody, 'utf8') > 262_144
        ) {
          return json(
            rawBody && signature ? 413 : 400,
            {
              error:
                rawBody && signature
                  ? 'BILLING_WEBHOOK_TOO_LARGE'
                  : 'BILLING_WEBHOOK_INVALID',
            },
          );
        }
        return json(
          200,
          await service.handleWebhook(
            rawBody,
            signature,
          ),
        );
      }

      if (!path.startsWith('/api/v1/billing/')) {
        return null;
      }

      const identity =
        await options.authenticate(request);
      if (!identity) {
        return json(401, { error: 'UNAUTHENTICATED' });
      }

      if (
        request.method === 'GET' &&
        path === '/api/v1/billing/status'
      ) {
        return json(200, await service.status(identity));
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/billing/checkout'
      ) {
        const body = await readJsonObject(request);
        const planId =
          typeof body.planId === 'string'
            ? body.planId
            : '';
        return json(
          200,
          await service.createCheckout(
            identity,
            planId,
            url.origin + '/?billing=success',
          ),
        );
      }

      if (
        request.method === 'POST' &&
        path === '/api/v1/billing/prepaid/checkout'
      ) {
        const body = await readJsonObject(request);
        const variantId =
          typeof body.variantId === 'string'
            ? body.variantId
            : '';
        return json(
          200,
          await service.createPrepaidCheckout(
            identity,
            variantId,
            url.origin + '/?billing=prepaid-success',
          ),
        );
      }

      if (
        request.method === 'GET' &&
        path === '/api/v1/billing/portal'
      ) {
        return json(
          200,
          await service.customerPortal(identity),
        );
      }

      return json(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      const status = errorStatus(message);
      return json(status, {
        error:
          status === 500
            ? 'INTERNAL_ERROR'
            : message,
      });
    }
  };
}
