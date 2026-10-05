import {
  DEFAULT_HOSTED_CONTROL_PLANE_URL,
} from '../connect.js';

function fail(code: string): never {
  throw new Error(code);
}

export function normalizeProductionControlPlaneUrl(
  input = DEFAULT_HOSTED_CONTROL_PLANE_URL,
): string {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    fail('INVALID_PRODUCTION_CONTROL_PLANE_URL');
  }
  return url.origin;
}

async function jsonBody(
  response: Response,
  code: string,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail(code);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    fail(code);
  }
  return body as Record<string, unknown>;
}

export interface PublicProductionAcceptance {
  controlPlaneUrl: string;
  health: {
    status: 200;
    ok: true;
    service: 'nexowire-control-plane';
    ownerPaidSpendAllowed: false;
  };
  billingAuthBoundary: {
    status: 401 | 503;
    protected: true;
    configured: boolean;
  };
  financialMutationPerformed: false;
}

export async function validatePublicProductionAcceptance(
  input: {
    controlPlaneUrl?: string;
    fetchImpl?: typeof fetch;
    expectBillingConfigured?: boolean;
  } = {},
): Promise<PublicProductionAcceptance> {
  const controlPlaneUrl =
    normalizeProductionControlPlaneUrl(
      input.controlPlaneUrl,
    );
  const fetchImpl = input.fetchImpl ?? fetch;

  const healthResponse = await fetchImpl(
    controlPlaneUrl + '/health',
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
    },
  );
  if (healthResponse.status !== 200) {
    fail(
      'PRODUCTION_HEALTH_HTTP_' +
        healthResponse.status,
    );
  }
  const health = await jsonBody(
    healthResponse,
    'PRODUCTION_HEALTH_INVALID_JSON',
  );
  if (
    health.ok !== true ||
    health.service !== 'nexowire-control-plane' ||
    health.ownerPaidSpendAllowed !== false
  ) {
    fail('PRODUCTION_HEALTH_CONTRACT_MISMATCH');
  }

  const billingResponse = await fetchImpl(
    controlPlaneUrl + '/api/v1/billing/status',
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
    },
  );
  const billingBody = await jsonBody(
    billingResponse,
    'BILLING_AUTH_BOUNDARY_INVALID_JSON',
  );
  let billingConfigured = false;
  if (
    billingResponse.status === 401 &&
    billingBody.error === 'UNAUTHENTICATED'
  ) {
    billingConfigured = true;
  } else if (
    billingResponse.status === 503 &&
    billingBody.error === 'BILLING_NOT_CONFIGURED'
  ) {
    billingConfigured = false;
  } else {
    fail(
      'BILLING_AUTH_BOUNDARY_HTTP_' +
        billingResponse.status,
    );
  }
  if (
    input.expectBillingConfigured === true &&
    !billingConfigured
  ) {
    fail('PRODUCTION_BILLING_NOT_CONFIGURED');
  }

  return {
    controlPlaneUrl,
    health: {
      status: 200,
      ok: true,
      service: 'nexowire-control-plane',
      ownerPaidSpendAllowed: false,
    },
    billingAuthBoundary: {
      status: billingResponse.status as 401 | 503,
      protected: true,
      configured: billingConfigured,
    },
    financialMutationPerformed: false,
  };
}
