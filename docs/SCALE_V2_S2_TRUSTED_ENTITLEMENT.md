# Scale v2 / S2: trusted server-side daily entitlement and offline reservation

> **2026-10-15 · TEST/DEV ONLY.** [S2 #484](https://github.com/Naveax/Nexowire/issues/484), [master #482](https://github.com/Naveax/Nexowire/issues/482). Does not register a Worker route, replace the monthly ledger, create a billing tier, change the database schema, or enable the dormant fused MCP endpoint.

## Objective and existing facts

Today's hosted production policy is **Free-only, 1,000 weighted credits/month**, with paid billing paused. Future proposal is **Free 1,000, Plus 5,000, Pro 10,000 accepted logical MCP tool calls/day**, plus a separately contracted finite Enterprise daily ceiling. The proposal is **not active**. A hosted MCP invocation may still generate multiple provider-side HTTP calls; those are separate from customer-visible logical invocation entitlements.

Before allowing any daily reservation, the server must derive current account/plan, actual quota subject and billing entitlement, never trust customer-provided `planId`, `trustedDailyLimit`, `quotaSubjectId`, or UTC time.

## DEV-only modules

`ProposedDailyEntitlementResolver` (`src/product/daily-entitlement-proposal.ts`) reads `ControlPlaneStore.getAccount(authenticatedAccountId)` and its `getQuotaSubject(account.quotaSubjectId)`. Free requires the existing `free-cluster` subject kind. Plus/Pro require a `subscription` subject kind **and** a matching same-account, same-plan provider subscription record in the server-side `BillingStore`. Paid entitlements are **OFF by default**, and tests explicitly enable the candidate only in their isolated fixture.

The DEV security policy permits currently `active` provider subscriptions and valid time-bounded `on_trial` records. It rejects `paused`, `past_due`, `unpaid`, `cancelled`, `expired`, wrong-account/wrong-plan records, expired end dates and future/invalid provider timestamps. This is intentionally stricter than some existing billing UI entitlement conventions. Trial and cancellation-grace business rules must be reconciled by a separate documented product decision before any deployment.

Enterprise/custom account plans **fail closed** with `enterprise-contract-required`; there is no implicit unlimited entitlement. A separate verified finite contract / organization allocation policy must be designed.

`ProposedTrustedDailyReservation` (`src/product/trusted-daily-reservation-proposal.ts`) composes the resolver and earlier `DailyRequestD1Ledger`. It uses a server-generated clock (not a caller-provided timestamp) and only the verified subject and daily cap. It accepts an account ID **already checked by the first-party authentication layer**. There is no HTTP route, and nothing in `cloudflare/worker.js` or the active hosted MCP caller imports this class. A failed subscription lookup or D1 write rejects/throws, never authorizes a tool as a free fallback.

## Local evidence

- `test/daily-entitlement-proposal.test.ts`: verified Free subject, default denied paid tiers, active Plus/Pro subscription, trial and end-time checks, wrong owner and mismatched quota-subject kind, paused/past_due/cancelled/unpaid denials, custom contract denial, unavailable billing authority.
- `test/daily-request-d1-ledger.test.ts`: tests integration of resolver → reservation → **real disposable file-backed SQLite D1 adapter**, including Free 1,000/day and DEV-active Plus 5,000/day, duplicate invocation rejection and fail-closed server/D1 outages.
- The previously merged S2 D1 fixture is still under `test/fixtures/scale-v2-daily-requests-staging.sql`. It is **not** in deployable `cloudflare/migrations/`. No provider usage data or real subscriptions were read.

```sh
node --test --import tsx test/daily-entitlement-proposal.test.ts test/daily-request-d1-ledger.test.ts test/daily-quota-proposal.test.ts test/fused-mcp-client-server-contract.test.ts
npm run typecheck
npm run build
npm run continuation:check
npm run ai-screen:launch-audit
```

## Non-negotiable remaining gates

1. **Atomic combined charge**: Current production monthly **weighted-credit ledger** and proposed daily **logical-request ledger** are separate. Before activation, accept/reject must be a single transactional server-authoritative decision or a rigorously proven reservation/compensation protocol that never over-admits or double-executes an ambiguous mutation. Current DEV composition does **not** solve this.
2. **Entitlement integrity and plan lifecycle**: subscription updates need verified webhooks, revocation, time ordering, explicit trial/grace handling, contract limits, shared quota subjects, organization membership and race-safe plan downgrade semantics.
3. **Cloudflare reality**: provider-specific D1 trigger behavior with independent Worker isolates, row reads/writes and request expense, p95 latency, outage/retry cases and capped owner spend need controlled and separately approved staging proof.
4. **Security**: token family / full account session revocation, per-device permission revocation, no replay at UTC crossover, sustainable replay-key retention and safe rollback.
5. **Production migration**: new versioned DB migration and default-OFF signed rollout only after independent review and explicit activation authorization. No background/automatic live transition.
