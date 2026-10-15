# Scale v2 — Active decision and execution ledger

> **Source of truth for initiative status:** [master #482](https://github.com/Naveax/Nexowire/issues/482), with phase issues #483–#487. Use this file only for concise versioned checkpoints. Keep stage checkboxes unchecked until code, CI and real acceptance are proven; GitHub documentation ≠ production deployment.

## Priority lock

- **Scope:** S1 Connection, S2 Daily Quota & Identity, S3 Verified One-Click Installer, S4 Subscription/Enterprise dormant engine, S5 Scale & Cost acceptance.
- **Deferred:** S6 feature modules; see [parked vision](SCALE_V2_S6_PARKED.md). Do not start feature development during this priority.
- **Preserve:** Existing Nexowire Agent v1.0.5 routes on distinct Work PC and Naveax PC; no planned restart, duplicate Agent or prod cutover.
- **Policy truth:** Current Free-only 1,000 weighted units/month, paid billing paused; *proposed future* 1,000/5,000/10,000 logical requests/day, Enterprise custom.
- **Cost guard:** No owner-funded overages, unbounded cloud relay, account-splitting to avoid limits or automatic paid provider upgrade.
- **Hold:** #271 live elevated runtime ACL issue remains user-paused; cannot elevate/cut over based on this plan.
- **Other parked projects:** [global #481](https://github.com/Naveax/Nexowire/issues/481). Unmerged PR #480 stays independently tracked.

## 2026-10-14 — Planning session checkpoint

| Item | Evidence | Status |
| --- | --- | --- |
| Inspect current plan source | README, ROADMAP, FREE_ONLY_POLICY, PRODUCT_CONTROL_PLANE, QUOTA_IDENTITY, ARCHITECTURE, AGENT_LIFECYCLE | Done (read-only GitHub) |
| Open initiative master | [#482](https://github.com/Naveax/Nexowire/issues/482) | Done |
| Split stages into issues | [#483 S1](https://github.com/Naveax/Nexowire/issues/483), [#484 S2](https://github.com/Naveax/Nexowire/issues/484), [#485 S3](https://github.com/Naveax/Nexowire/issues/485), [#486 S4](https://github.com/Naveax/Nexowire/issues/486), [#487 S5](https://github.com/Naveax/Nexowire/issues/487) | Done |
| Write architecture, checklist, quota and no-disconnect docs | SCALE_V2_VISION / ROADMAP / QUOTA_AND_COST / CONNECTION_ROLLOUT | Drafted in documentation branch, review required |
| Code changes to S1–S5 | No implementation in this documentation-only checkpoint | **Not started** |
| Hosted quota migration or payment activation | None | **Not deployed / billing paused** |
| Staging and load tests | None | **Not started** |
| Existing Native Agent or Broker restarted | No mutation attempted in this planning pass | Not applicable |

## Next concrete implementation slice — S1 only

1. At the next authorized coding turn, capture exact current `main` and open PRs; inspect `src/hub/agent-websocket.ts`, `src/core/agent-broker.ts`, `src/relay/server.ts`, `src/connect.ts`, Cloudflare MCP routes and D1 quota handlers.
2. Create an **instrumentation-only DEV branch** (no live deployment) measuring actual hosted MCP ingress, hub-agent messages, relay bytes, D1 operations, reconnect/failure and authenticated route selection.
3. Add synthetic deterministic tests for repeated request-id, drops, reconnect and two-device routing; do not restart existing agents.
4. Review results under [S1 #483](https://github.com/Naveax/Nexowire/issues/483) with exact SHA, test command, aggregate measurements and whether P2P would materially reduce *this* traffic class.
5. Only then prototype optional feature-flagged transport adapter / P2P for supported first-party clients. Keep old outbound WebSocket default and no production cutover.
6. S2 quota schema is designed in parallel, but changes to deployed metering require explicit versioned acceptance and separate launch decision.

## 2026-10-15 — S1 instrumentation slice 1 (DEV only)

- Docs PR [#488](https://github.com/Naveax/Nexowire/pull/488) merged as `2a1ba73d0b0320b94cf9d89e30cae56f143432de` after exact-head 7/7 CI. S1-S5 stages remain OPEN.
- S1 DEV worktree branch `feat/scale-v2-s1-transport-metrics-20261015` adds **opt-in, in-memory, payload-free** counters for AgentBroker WebSocket frames/bytes, live connection/disconnection, resumed/rejected pending requests and relay frame bytes, connections and unauthorized upgrades.
- Designed as optional constructor/start argument; **no live Agent/Hub/Broker or Cloudflare changes**. Real loopback WebSocket relay + reconnect tests are synthetic fixtures and are not production traffic measurements.
- Validation: `npm run typecheck`, `npm run build`, `npm run ai-screen:launch-audit`, 13/13 targeted Node tests PASS on authorized Windows DEV; CI needs a separate exact-head PR run. The launch audit still counts 56 direct sinks / 43 signatures. No new direct process launch sinks.
- Documented precise limitations in [S1 metric design](SCALE_V2_S1_METRICS.md): application bytes are not billed network bytes; no hosted MCP ingress count, D1 read/write, p95 latencies or actual relay invoice yet; no NAT/P2P inference; metric state resets on restart.
- Next slice after review: add redacted hosted ingress/D1 usage measurements behind a DEV flag with fixed-label bounded histograms. Compare measured ingress with logical invocation before any P2P proposal; never equate peer-transfer savings with eliminating ChatGPT MCP requests.

## 2026-10-15 — S1 Worker ingress fan-out cost discovery (offline)

- **Current hosted MCP tool path**: the real `ControlPlaneMcpClient` normally posts `/api/v1/internal/mcp/authenticate` then `/api/v1/internal/usage/charge`. An accepted hosted single-tool execution therefore reaches the control-plane Worker **twice**; retries, pairing and device presence generate additional Worker requests. See [S1 Worker fan-out evidence](SCALE_V2_S1_WORKER_INGRESS_FANOUT.md) and `test/scale-worker-capacity-model.test.ts`.
- Deterministic, bounded offline demand model isolates exact assumptions rather than claiming production Cloudflare cost. In a hypothetical 100k Worker requests/day shared budget, just **50 users × 1,000 hosted tool calls/day × 2** exhaust the pool with no overhead budget.
- **Potential optimization, NOT IMPLEMENTED**: fused per-tool owner-bound authentication + atomic ledger reservation endpoint with exact idempotency/permission/revocation checks could remove one Worker request on this narrow path. No dangerous local credential caching or unmetered bypass.
- This is a source-path and fake-network test, not actual Cloudflare ingress, D1 rows, user traffic or capacity proof. Current effective Free-only **monthly** policy and paused billing remain unchanged. S1 #483 stays open; S6 feature development parked.

## 2026-10-15 — S1 fused OAuth + quota reservation, default OFF

- PR #491 Worker ingress fan-out test merged to main as `832a995f82bcdde2497751f78b73b67014037f77` after 7/7 exact-head GitHub CI. Two authenticated control-plane Worker requests/accepted hosted tool call were confirmed by real Hub-client mock-fetch routing (not production traffic).
- DEV isolated candidate `src/product/fused-mcp-authorize-charge.ts` uses existing service token authentication, **fresh** OAuth token checks, current account/role ownership and tool ACL, device/folder projection, and exactly the existing atomic quota charge + invocation event namespace.
- Proposed `/api/v1/internal/mcp/authorize-charge` is wired to `cloudflare/worker.js` only beneath the **hardcoded false** `PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED` compile-time gate. Production route remains uncallable, existing double Worker request paths and monthly Free-only policy unchanged; not deployed or enabled.
- Local Windows DEV validation: 28/28 targeted hosted auth/charge tests (including real SQLite D1-backed quota, concurrent same-ID replay, invalid token, privilege/feature/limit rejection, explicit gate-off), plus typecheck, worker syntax, launch audit passed. Multitenant distributed D1 contention, real OAuth token lifecycle, rollout client and provider-billed cost still require testing.
- See [fused-auth architecture and rollout gates](SCALE_V2_S1_FUSED_AUTH_CHARGE.md). Next slice: isolated Hub-client single-call parser and protocol acceptance, auth token revocation/parallel SQLite D1, staged canary with secure fallback, exact GitHub CI.

## 2026-10-15 — S1 combined-route Hub client parser (isolated DEV)

- New `FusedMcpAuthorizeChargeClient` supports the candidate **one remote Worker request** with stable invocation ID and explicit bounded request fields; it does **not** replace the current `ControlPlaneMcpClient` or run in the current Hub process. Candidate server support merged from PR #492 (`51e386a7c08142ab2af472fbf860a100e923ef17`, exact-head 7/7 CI) and remains production-OFF by a hardcoded gate.
- Strict current ownership/SAFE-FULL/role projection parsing, exact charged-status validation, explicit error classification, and **no automatic retry or fallback on uncertain reservation outcome**. Authenticated and denied protocol fixture tests use a fake fetch; no real Cloudflare traffic.
- Windows DEV integrated rebase tests: 38/38 client/server, real SQLite D1, legacy MCP auth/metering and replay tests pass; `npm run typecheck` and `npm run build` pass. Persistent `test/fused-mcp-client-server-contract.test.ts` now covers one-call/one-reservation, concurrent replay, role denial, token revocation and exhausted quota. Before integration, require real OAuth/D1 and exact-head CI plus rollout gates in [client contract](SCALE_V2_S1_FUSED_CLIENT.md).
- Work PC and Naveax existing native agents remain intended to be untouched; S1 not complete; S2-S5 planned; S6 parked.

## 2026-10-15 — S1 owner-scoped access-token invalidation primitive (DEV only)

- Added `McpOAuthService.invalidateAccessToken(accessToken, authenticatedAccountId)` and store implementations. D1 uses the **existing** access-token `expires_at` column, conditional on token hash, expected authenticated account ID and still-active expiry. No database migration, endpoint or production flag changes.
- Current OAuth access-token authentication rejects the shortened expiry immediately on subsequent checks; 12 concurrent invalidation attempts on the real SQLite D1 adapter yield one successful UPDATE, with no cross-account effect.
- Windows DEV: 18/18 targeted OAuth, D1 and fused authorization tests plus TypeScript and build PASS.
- **Important limit:** the associated refresh token can still mint a new access token. This is only a single-token denial primitive, **not** a full session logout, account-wide revoke, permission propagation, or distributed Worker/D1 race proof. In-flight operations prior to invalidation also need separate cancellation semantics.
- See [S1 access-token invalidation contract](SCALE_V2_S1_ACCESS_TOKEN_INVALIDATION.md); S1 acceptance and production gates remain OPEN, full owner-authorized token-family revocation pending.

## 2026-10-15 — S2 daily request quota proposal (simulation only)

- `src/product/daily-quota-proposal.ts` models the proposed Free **1,000**, Plus **5,000**, Pro **10,000** accepted **logical hosted MCP tool invocations per UTC day**, plus an explicit finite negotiated Enterprise ceiling. This is intentionally distinct from both current 1,000 weighted **monthly** Free credits and the real number of Cloudflare Worker HTTP fetches.
- The implementation is a bounded in-memory **simulation**, not a replacement or activation of D1/Worker/billing. Paid tiers require a test-only simulated trusted entitlement; future live entitlements must be issued by the server, never self-asserted by a user.
- Single-process DEV **7/7** tests cover limits, UTC midnight, replay across days, independent owner keys, local 12-way same-ID replay, bounded-memory fail-closed handling, paid entitlement rejection and positive Enterprise quota validation.
- Replay dedup across day rollover is essential: daily counters may reset while idempotency must persist. Real independent Worker/D1 atomic reservation, retention, provider cost envelopes, subscription verification and safe staged rollback remain **NOT IMPLEMENTED**. See [S2 quota definition](SCALE_V2_S2_DAILY_QUOTA_PROPOSAL.md); production remains Free-only monthly and checkout paused.

## 2026-10-15 — S2 atomic daily D1 SQL prototype (isolated DEV)

- Staging-only `test/fixtures/scale-v2-daily-requests-staging.sql` defines per-quota-subject UTC day counters and an invocation ledger with a cross-day stable replay key, enforced with a **single-statement SQL trigger**. Deliberately NOT placed under automatically deployed `cloudflare/migrations/`.
- `DailyRequestD1Ledger` test-only caller accepts authenticated-server-resolved quota subject and daily ceiling, uses existing D1 database interface; on duplicate, cap exhaustion or any ambiguous D1 failure it must **never return a new authorized reservation**. Not integrated with the running Worker/Hub/legacy monthly weighted-credit charge.
- DEV file-backed SQLite test with **two open connections** exercises Free 1,000/1,001, 12 distinct concurrent requests at 999/1,000 (only one allowed), 16 parallel same-ID attempts (one allowed, 15 duplicate), cross-midnight replay, account isolation and plan downgrade. Legacy monthly usage unchanged.
- Local typecheck/build and **26/26** combined S1/S2 regression tests were green before the final staging-fixture placement revision; exact test/CI outcome to be recorded separately. Full Cloudflare independent Worker-D1 transactions, billable rows, owner-authenticated paid plans and cross-Worker latency remain unverified. See [S2 atomic daily design](SCALE_V2_S2_ATOMIC_D1_LEDGER.md).
- Requires owner-approved staged migration review and rollback before any activation. Existing production monthly Free-only policy, billing pause, and original Agent routes remain unchanged.

## Each future status report must record

- **Date/time, issue number, exact commit/branch, affected paths and observable device/production impact.**
- **Current live state versus branch-only state; completed unit tests versus physical/paid/provider acceptance; what is unknown.**
- **Cloud request cost and hard-stop impact (measured, projected, or unknown); SLO impact; branch/CI exact-head link.**
- **Rollback, temporary resource cleanup, and proof both original agents remain reachable where applicable.**
- **Next single actionable slice; blockers and owner approvals required.**

This ledger is updated through reviewed commits/PRs; issue comments store intermediate status without implying merge or deployment.
