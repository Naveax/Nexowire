# Control-plane HTTP v0

The product control plane is provider-neutral and uses Web Standard Request/Response primitives.

## Public product endpoints

- GET /api/v1/me/dashboard
- GET /api/v1/admin/overview
- POST /api/v1/pairing
- POST /api/v1/pairing/consume

## Internal endpoint

- POST /api/v1/internal/usage/charge

The internal usage endpoint requires an authenticated service identity. User-controlled headers are not a production authentication mechanism; tests inject identities through a test-only authenticator.

## Security invariants

- account identity must be authenticated outside the handler and injected;
- admin access requires both an admin identity and an admin account flag;
- pairing tokens are high-entropy, short-lived, single-use, and stored only as digests;
- device credentials are returned once and stored only as SHA-256 digests;
- usage charging is idempotent by account + billing period + event id;
- free/subscription quotas and prepaid balances fail closed;
- the control plane never enables owner-paid overage.

## Persistence

MemoryControlPlaneStore exists only for deterministic tests.

Production adapters must implement ControlPlaneStore with atomic usage charging. The intended first hosted adapter is Cloudflare D1, but business logic must remain independent from Cloudflare so the service can move without rewriting product rules.
