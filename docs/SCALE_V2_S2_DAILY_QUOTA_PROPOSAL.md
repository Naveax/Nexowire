# Scale v2 S2 | Proposed UTC-daily logical request quota model

> **2026-10-15 · Design and in-memory simulation only. NOT active in hosted Worker, usage ledger, billing, Hub or paid plans.** [S2 issue #484](https://github.com/Naveax/Nexowire/issues/484), [master #482](https://github.com/Naveax/Nexowire/issues/482).

## Definition: what does one "request" mean?

The user's requested future tier ceiling is counted in **accepted logical hosted MCP tool invocations**, each accepted tool invocation consumes one proposed daily request. This is deliberately **not the count of Cloudflare Worker HTTP subrequests**, and it is not the current weighted 1x/5x legacy credit accounting. For example, one existing hosted tool call currently generates an OAuth-check POST and a charge POST, but those are server-internal requests and should not consume two user-visible daily request entitlements. Such subrequests still consume real hosting budget, which needs independent hard-stop protection.

| Proposed product tier | Accepted logical hosted tool invocations per UTC day | Validation |
| --- | ---: | --- |
| Free | 1,000 | Fixed design target, NOT active |
| Plus | 5,000 | Server-verified paid entitlement required, NOT active |
| Pro | 10,000 | Server-verified paid entitlement required, NOT active |
| Enterprise | Negotiated finite positive limit | Owner/organization contract and resource budget required, NOT active |

The request quota does **not** grant unlimited parallel tasks, compute hours, generated tokens, relay traffic, screen frames or device access. Each needs separate enforcement and cost accounting. Enterprise is **not unlimited** by default.

## Implementation in this PR

`src/product/daily-quota-proposal.ts` is a pure, opt-in design module and bounded **single-process simulation**. It is not imported from the existing production quota store, `ControlPlaneService`, Worker routing or subscription activation.

- Uses `UTC YYYY-MM-DD` day buckets, avoiding the owner's local timezone for metering; validates timestamps and bounded integer limits.
- 1,000 / 5,000 / 10,000 limits are proposal constants, not actual current plan entitlements. Enterprise requires an explicit positive finite daily request limit.
- A simulated paid plan requires `trustedPaidEntitlement=true`. **This is a test harness placeholder, not verified cryptographic billing authority.** A future implementation must derive this from a trusted server-side subscription/organization record, never user input.
- Global per-account invocation dedup prevents the same stable invocation identifier from being treated as a new logical task across UTC midnight; per-day accepted-invocation count resets. Same invocation IDs for *different* owners do not collide.
- If the in-memory simulator reaches its bounded event capacity, it fails closed instead of granting unmetered work.
- Tests use only synthetic account and invocation keys. This simulator retains synthetic identifiers in-process and is **not suitable for production/telemetry**.

## Known gap: distributed atomicity and retention

The production design needs a *server-authoritative*, account/organization-bound D1 ledger that atomically checks and reserves request entitlement **and** preserves global invocation idempotency across UTC boundary. Protect against parallel Cloudflare Worker instances, retries after network failure, forged subjects, billing-plan changes, clock skew, unpaid Plus/Pro privileges and month-to-day cutover.

The in-memory simulation does not prove any of those distributed properties. A production schema must have a reviewed retention policy for replay keys, without enabling dangerous replay after expiry. Ordinary Workers Free/paid request, D1 row, relay bandwidth and shared provider capacity limits remain **independent** of user-visible quota counters.

## Existing production behavior remains authoritative

Existing `PRODUCT_PLANS.free.monthlyCredits=1000` and the Free-only/paid-billing-paused gates remain active. Do **not** apply these UTC-daily limits to live accounts or advertise them as effective packages. S2 requires a versioned data migration, cross-month and daily cutover rules, authenticated subscription entitlements, atomic D1 row updates, negative concurrent tests, a two-way rollback and owner-approved staged release.

## Tests

```sh
node --test --import tsx test/daily-quota-proposal.test.ts
npm run typecheck
npm run build
```

The 7 test cases cover all tier targets, Free limit exhaustion, paid-entitlement denial, Enterprise finite contract validation, UTC/Türkiye timezone boundary, replay across days, independent account subjects, local concurrent same-ID attempts and fail-closed memory cap.

**Next S2 slice:** additive D1-backed dual-ledger design in isolated staging, not a production switch. Coordinate S1 merged fused auth+quota server/client changes before deciding what constitutes a single atomic reservation.
