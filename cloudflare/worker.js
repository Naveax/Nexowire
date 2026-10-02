// Cloudflare Worker deployment adapter.
// This file intentionally stays dependency-light. Production user authentication
// is added in the next control-plane auth layer; until then API routes fail closed.

import { D1ControlPlaneStore } from '../dist/src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../dist/src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../dist/src/product/control-plane-http.js';

function fixedTimeSafeCapacity(env) {
  const raw = Number(env.NEXOWIRE_FREE_CAPACITY_PERCENT ?? '0');
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(100, raw))
    : null;
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

    if (url.pathname.startsWith('/api/')) {
      const store = new D1ControlPlaneStore(env.DB);
      const service = new ControlPlaneService(store, {
        infrastructure: () => ({
          freeCapacityPercent: fixedTimeSafeCapacity(env),
          prepaidCapacityCredits: 0,
        }),
      });

      const handler = createControlPlaneHttpHandler(service, {
        authenticate: async () => null,
      });
      return handler(request);
    }

    return env.ASSETS.fetch(request);
  },
};
