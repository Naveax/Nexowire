# Temporary free-only policy

This deployment remains free until the owner manually enables billing after legal
eligibility and Lemon Squeezy/Stripe account approval. Do not auto-enable based on
the date of the owner's birthday or the presence of API keys.

## Hosted quota

Read-only public policy metadata at GET /api/v1/public/usage-policy
reports the server's Free monthly limit and standard/skill tool weights
without login or private account data. This proves the deployed configuration,
not the remaining quota of any particular authenticated user.

- **Free: 1,000 weighted units per UTC calendar month**, per quota subject.
- **Repository-owner exception (explicitly requested 2026-10-07):** the Nexowire
  account linked by GitHub OAuth to immutable GitHub user ID `79841922`
  (repository owner) has no **hosted MCP tool-credit ceiling** while Free-only
  is active. The implementation verifies the server-stored `github`
  external-identity mapping, not an account name, admin flag, client claim or
  supplied GitHub login string. It returns `monthlyCredits: null` only for
  this account. Without that verified mapping, the normal Free cap applies.
- The owner exception does **not** enable premium-only tools, paid billing,
  additional account/device entitlements or external provider resources. It
  preserves D1 charge records, 5x skill weighting and 409 replay prevention.
  Cloudflare/ChatGPT/provider quotas and compute capacity remain independent.
- A regular hosted MCP tool invocation costs 1 unit.
- Direct `skill_*` and `skills_*` tools cost 5 units.
- A call from a special-skill workflow costs 5 units when its authenticated
  hosted MCP request carries `params._meta['nexowire/special-skill'] = true`.
  This marker is forwarded through the service-only usage endpoint to the
  server-side atomic quota ledger.
- The host cannot infer whether an otherwise ordinary unmarked tool call was
  mentally triggered by skill instructions. The invoking workflow MUST add the
  marker on every nested call requiring 5x weighting; unmarked ordinary calls
  cost 1. Do not claim otherwise.
- Existing premium tool entitlements remain gated for Free users.
- Each hosted HTTP tool invocation gets a fresh server-generated invocation
  ID, even if a different MCP session reuses the same JSON-RPC request ID.
  Thus repeated intentional calls are all metered; no identical-call bypass.
- To safely identify a real network retry, callers MAY supply a bounded
  stable params._meta['nexowire/invocation-id'] for that one invocation.
  D1 records it idempotently, and repeated submissions return HTTP 409
  MCP_DUPLICATE_REQUEST **before tool execution**, not an unmetered
  second execution. Fresh logical calls must get fresh invocation IDs.
- Without an explicit stable invocation ID, each HTTP retry is treated as
  a new chargeable request. Mutations should not be blindly retried.
- New periods start on the **first day of each month at 00:00 UTC**.
- At exhaustion, deny before dispatch (no postpaid charges, no owner-paid overage).
- Previous usage in the current UTC month stays counted when the new 1,000-unit
  limit is deployed; no artificial quota resets.
- User/device identity linking shares quota through the existing free-cluster
  subjects. Locally self-hosted calls remain outside hosted metering by design.

## Billing paused

Cloudflare Worker defaults to free-only whenever
`NEXOWIRE_PAID_BILLING_ENABLED` is not exactly `true`.

- All `/api/v1/billing/*` routes return 503 `BILLING_PAUSED`.
- The control-plane service resolves legacy paid accounts to Free entitlements
  while this flag is off, without rewriting their stored plan records.
- Admin custom-prepaid configuration returns `BILLING_PAUSED`.
- The web dashboard shows Free limits, hides purchase links, and disables
  checkout actions even if an old paid response is cached.
- Existing Lemon Squeezy integration code and automated tests remain intact
  for future deliberate activation; live payments are not configured now.

To re-enable paid billing **after verification**, the owner must explicitly
approve production activation and configure live Lemon Squeezy credentials,
catalog variants, webhooks, protected provisioning, CI, and acceptance checks.
Merely turning on a flag is not a production approval.

## Useful tests

```sh
npm run typecheck
node --test --import tsx test/free-only-usage.test.ts test/hosted-metering.test.ts test/quota-subject-d1.test.ts
npm run check
```
