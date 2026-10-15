# Scale v2 S2: trusted dual-quota admission composition (DEV-only)

Date: 2026-10-15. Issue [#484](https://github.com/Naveax/Nexowire/issues/484), master [#482](https://github.com/Naveax/Nexowire/issues/482). Stacks on the unmerged #499 SQLite/D1 staging candidate.

## Implemented in this isolated development slice

`src/product/trusted-dual-admission-proposal.ts` composes existing server-authoritative `ProposedDailyEntitlementResolver.resolve` with the canonical `PRODUCT_PLANS`/ `quoteToolUsage` monthly weighted credit quote and one `ProposedDualQuotaD1Ledger.reserve` call.

The proposed server boundary accepts only an **already authenticated first-party account**, a bounded stable invocation ID, and the requested tool name. A mandatory **current scope/role/owner/device permission provider** is called before entitlement resolution and before any quota charge. The quota subject, tier, daily limit, monthly cap, weight and billing mode are resolved on the server and cannot be chosen through the MCP body. IDs use the same legacy `hostedMcpUsageEventId(accountId, invocationId)` hash to avoid changing existing monthly identity unintentionally.

The adapter neither registers a Worker endpoint nor executes tools. It returns a reservation decision; only a future separately approved owner-bound call path may use a successful `reserved` result to execute a tool. `duplicate`, `daily-exhausted`, `monthly-exhausted`, denied permission/entitlement/feature and unknown errors never grant execution. It performs **one** joint ledger reservation, not independent daily and monthly charges. Null/unlimited or prepaid plans are unsupported, and paid entitlements are still default-OFF in the underlying resolver.

## DEV evidence

- `test/trusted-dual-admission-proposal.test.ts`: 11/11 PASS, using injected fake entitlement/permission/ledger dependencies for orchestration checks.
- Together with existing entitlement, daily, and real file-backed SQLite dual-ledger tests: **47/47 PASS** on Windows DEV, including 16 parallel replays and atomic quota rollback.
- `npm run typecheck`, `npm run build`, `npm run continuation:check`, `npm run ai-screen:launch-audit`: PASS.
- These results **do not** prove Cloudflare D1 provider concurrency, billed row usage, latency, or end-to-end live OAuth correctness.

## Unresolved BLOCKING gates before integration or rollout

1. This staging composition's `authorizeCurrentScopeAndOwnership` is injected, not wired to the real first-party OAuth/service authentication. It needs a verified, current token/scope and account/role/device/owner check. Permission revocation between charge and execution is still a race.
2. `ControlPlaneService.chargeUsage` (monthly-only) and any daily-only path must be sealed off when switching to one authoritative charge route. A shared idempotency/execution boundary with the Hub and stable original invocation ID is mandatory; never silently fall back on timeout.
3. Old monthly-only events were unique within the **old month**, not necessarily forever. Replayed older-month operations and account-to-new-subject transitions require a versioned historical replay fence, backfill and explicit fail-closed cutover proof. The hash alone does NOT solve this.
4. D1 nested triggers, two independent Worker isolates, SQL error classification, `meta.changes`, ambiguous commit outcomes and non-replay after network outage need actual bounded Cloudflare staging tests and separately approved cost guard.
5. Full access/refresh token-family revocation and in-flight permission invalidation, real paid webhook/trial/downgrade/enterprise contract semantics, rollback/DR and owner cost hard-stop remain open.
6. All deployed routes, feature flags, new daily quotas, payment activation, Cloudflare migrations and both Native Agents remain unchanged. No staging fixture was promoted to `cloudflare/migrations`.

**Go/no-go:** Never authorize a mutating tool from a duplicate, an exhausted period, an unknown D1 result or an unverified entitlement. Do not call this an accepted production integration.
