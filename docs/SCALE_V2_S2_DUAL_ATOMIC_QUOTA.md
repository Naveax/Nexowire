# S2: Dual daily + monthly atomic quota reservation (STAGING-ONLY)

> **2026-10-15, experimental test fixture.** [S2 #484](https://github.com/Naveax/Nexowire/issues/484), [master #482](https://github.com/Naveax/Nexowire/issues/482). Depends on trusted owner/plan resolver PR #498. This is not deployed, does not enable new daily limits or paid plans and cannot be called from the production Hub/Worker.

## Why one combined transaction is necessary

Today the effective hosted Free-only policy is **1,000 weighted credits/UTC month**; the planned S2 policy adds Free 1,000, Plus 5,000 and Pro 10,000 **logical accepted tool invocations/UTC day**, with separately signed finite Enterprise contracts later. Calling the two quota systems separately is unsafe: a daily reservation might succeed while a monthly charge fails, or vice versa. Any unsafe retry could double-execute a mutating command.

The experimental `test/fixtures/scale-v2-dual-quota-staging.sql` adds an owner-bound `dual_quota_reservations` table and a nested SQLite `AFTER INSERT` trigger. In **one top-level INSERT SQL statement**, the trigger inserts the request into the existing S2 daily invocation ledger **and** the existing production-schema monthly `quota_usage_events` ledger, each enforced by their own existing triggers. All updates and inserted events are part of the **same SQLite statement atomicity boundary**: if either quota or a UNIQUE/FK/CHECK constraint rejects, every effect is rolled back. This is separate from and **not added to** deployable `cloudflare/migrations/`.

`src/product/dual-quota-d1-proposal.ts` exposes `ProposedDualQuotaD1Ledger.reserve`, a standalone and **unwired** D1 adapter. Its arguments `quotaSubjectId`, `dailyLimit`, `monthlyCredits`, `toolCredits`, `billingMode` and `invocationId` **must be first-party server-authenticated/quoted** if a future approved integration ever uses it. They are not safe client/MCP JSON inputs. UTC day/month are derived internally from the trusted clock.

The global per-subject stable `invocationId` primary key in `dual_quota_reservations` **omits day and month**; the same logical request is never admitted a second time after period rollover. An ambiguous write error is not treated as successful: if the committed reservation is visible it reports **duplicate** to prohibit a second tool execution, otherwise only known quota rejections are classified, and other errors propagate to fail closed.

## Verified Windows DEV cases

- One accepted tool call charges 1 daily invocation + 5 monthly weighted credits.
- Monthly-credit limit failure leaves the daily counter, monthly counter and all three event ledgers unchanged.
- Daily limit failure leaves the monthly charge and all three event ledgers unchanged.
- Two open file-backed SQLite connections: 16 parallel same IDs reserve once, 15 duplicates; 999/1,000 with 12 distinct calls accepts exactly one and rejects 11.
- Global replay protection crosses UTC days and months. A different owner has separate invocation identity and quota.
- Unknown backend failure, invalid limits or credits fail closed.
- A pre-existing **legacy monthly-only** event ID cannot be inserted into the combined path without a UNIQUE rejection and rollback of any daily reservation; a pre-existing **daily-only** event similarly cannot produce a partial monthly charge. These conflict cases intentionally remain unavailable rather than silently granting another mutation.
- Existing monthly ledger trigger remains unmodified; no old quota migration or production configuration change.

These are **SQLite contract tests, not real Cloudflare D1 multi-Worker acceptance**. SQLite nested-trigger semantics and row-count metadata must be verified with real D1. Provider errors may not preserve human-readable trigger error codes, so parsing error substrings is **only provisional**: any unrecognized failure must be treated as unavailable, never as permission to execute.

## Unresolved acceptance gates

- [ ] **Single authoritative live route**: block old independent monthly-only/daily-only paths, or migration can be bypassed despite joint ledger safety. Integrate the unified monthly usage-policy quote, current tool permissions, subscription entitlement, identical event ID and owner quota subject in a first-party transaction plan without trusting client values.
- [ ] **Existing legacy invocations**: historical monthly event keys were scoped per month; define replay and transition backfill so a previously accepted mutating call cannot be replayed after the new joint ledger goes live. No production migration until this is proven.
- [ ] **Entitlement lifecycle**: provider webhook verification, cancellation, plan downgrades, group/shared subjects and finite Enterprise contract; reconcile paused/trial/payment grace states.
- [ ] **Operational correctness**: independent Cloudflare Workers and D1 concurrency, timeout/commit ambiguity, retention, billable row reads/writes, p95 latency, provider limits and owner-controlled spend caps.
- [ ] **Full session revocation** and device permission invalidation; single-token expiry is not sufficient.
- [ ] **Controlled rollout**: separate versioned production migration only after explicit permission, signed default-OFF canary, rollback/DR test, no unauthorized checkout or Cloudflare paid-plan upgrade.

## Local verification

```sh
node --test --import tsx test/dual-quota-d1-proposal.test.ts test/daily-entitlement-proposal.test.ts test/daily-request-d1-ledger.test.ts test/daily-quota-proposal.test.ts
npm run typecheck
npm run build
npm run continuation:check
npm run ai-screen:launch-audit
```

Source and test files exist solely in an isolated DEV branch. No production Worker import, deployed schema, native Agent update, or privileged runtime adjustment is included.
