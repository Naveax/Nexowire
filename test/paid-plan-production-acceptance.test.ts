import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProductionControlPlaneUrl,
  validatePublicProductionAcceptance,
} from '../src/product/paid-plan-production-acceptance.js';

test('production acceptance normalizes only clean HTTPS control-plane roots', () => {
  assert.equal(
    normalizeProductionControlPlaneUrl(
      'https://nexowire.example/',
    ),
    'https://nexowire.example',
  );
  for (const value of [
    'http://nexowire.example',
    'https://user@nexowire.example',
    'https://nexowire.example/path',
    'https://nexowire.example/?x=1',
    'https://nexowire.example/#fragment',
  ]) {
    assert.throws(
      () => normalizeProductionControlPlaneUrl(value),
      /INVALID_PRODUCTION_CONTROL_PLANE_URL/,
    );
  }
});

test('public production acceptance is read-only and enforces zero owner spend plus billing auth boundary', async () => {
  const requests: Array<{
    url: string;
    method: string;
  }> = [];
  const fetchImpl: typeof fetch = async (
    input,
    init,
  ) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    requests.push({ url, method });

    if (url.endsWith('/health')) {
      return Response.json({
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: false,
      });
    }
    if (url.endsWith('/api/v1/billing/status')) {
      return Response.json(
        { error: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }
    throw new Error('unexpected URL ' + url);
  };

  assert.deepEqual(
    await validatePublicProductionAcceptance({
      controlPlaneUrl: 'https://nexowire.example',
      fetchImpl,
    }),
    {
      controlPlaneUrl: 'https://nexowire.example',
      health: {
        status: 200,
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: false,
      },
      billingAuthBoundary: {
        status: 401,
        protected: true,
        configured: true,
      },
      financialMutationPerformed: false,
    },
  );

  assert.deepEqual(requests, [
    {
      url: 'https://nexowire.example/health',
      method: 'GET',
    },
    {
      url:
        'https://nexowire.example/api/v1/billing/status',
      method: 'GET',
    },
  ]);
});

test('public production preflight accepts fail-closed unconfigured billing but deploy acceptance requires configuration', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: false,
      });
    }
    if (url.endsWith('/api/v1/billing/status')) {
      return Response.json(
        { error: 'BILLING_NOT_CONFIGURED' },
        { status: 503 },
      );
    }
    throw new Error('unexpected URL ' + url);
  };

  const preflight =
    await validatePublicProductionAcceptance({
      controlPlaneUrl: 'https://nexowire.example',
      fetchImpl,
    });
  assert.deepEqual(preflight.billingAuthBoundary, {
    status: 503,
    protected: true,
    configured: false,
  });

  await assert.rejects(
    validatePublicProductionAcceptance({
      controlPlaneUrl: 'https://nexowire.example',
      fetchImpl,
      expectBillingConfigured: true,
    }),
    /PRODUCTION_BILLING_NOT_CONFIGURED/,
  );
});

test('public production acceptance fails closed when spend policy or auth boundary drifts', async () => {
  const spendDrift: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: true,
      });
    }
    throw new Error('unexpected URL ' + url);
  };
  await assert.rejects(
    validatePublicProductionAcceptance({
      controlPlaneUrl: 'https://nexowire.example',
      fetchImpl: spendDrift,
    }),
    /PRODUCTION_HEALTH_CONTRACT_MISMATCH/,
  );

  const authDrift: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({
        ok: true,
        service: 'nexowire-control-plane',
        ownerPaidSpendAllowed: false,
      });
    }
    if (url.endsWith('/api/v1/billing/status')) {
      return Response.json(
        { plan: 'free' },
        { status: 200 },
      );
    }
    throw new Error('unexpected URL ' + url);
  };
  await assert.rejects(
    validatePublicProductionAcceptance({
      controlPlaneUrl: 'https://nexowire.example',
      fetchImpl: authDrift,
    }),
    /BILLING_AUTH_BOUNDARY_HTTP_200/,
  );
});
