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

## 2026-10-15 — S2 trusted plan authorization and D1 preflight (isolated DEV)

- PR #497 atomic daily D1 ledger **merged into main** after exact-head **7/7 CI** as `f1bcd7f7a8010dce00e3552d9b854bcc10cd14f7`. Staging schema is test-only, not deployable.
- Added a standalone `ProposedDailyEntitlementResolver`: resolves account and quota subject exclusively from first-party ControlPlaneStore, requires matching owner/plan `BillingStore` provider subscription for Plus/Pro, rejects ambiguous, paid disabled by default, Enterprise requires a separately negotiated finite contract. Active/on-trial policy is stricter than existing billing UI and requires product reconciliation.
- Added `ProposedTrustedDailyReservation`: uses only a server-derived UTC clock and verified daily cap/subject to invoke the test-only D1 reservation. Not wired into Worker, Hub or the production quota ledger.
- New DEV tests with real file-backed SQLite adapter prove the trusted Free limit, simulated verified Plus limit, duplicate protection, wrong account, paused/past-due/unpaid/cancelled, unknown provider or D1 failures. **29/29** S1/S2 combined tests and TypeScript green, build and CI to be recorded separately.
- **Critical open gate**: daily logical request reservations and existing monthly weighted usage charge are not yet one atomic decision. Do not activate until a transactionally proven dual-charge, separate paid-plan lifecycle authority, real multi-Worker D1 contention and provider limits, owner-approved staging and explicit rollback.
- See [S2 trusted entitlement contract](SCALE_V2_S2_TRUSTED_ENTITLEMENT.md). S2 #484 remains OPEN; Free-only monthly policy, paid billing pause, original Agents and #271 privileged hold unchanged.

## 2026-10-15 — S2 combined UTC daily and legacy monthly atomic quota (DEV)

- Added `src/product/dual-quota-d1-proposal.ts` and `test/fixtures/scale-v2-dual-quota-staging.sql`, staging-only standalone and **NOT in deployed `cloudflare/migrations/`**. One top-level SQLite `INSERT` and nested trigger write both S2 UTC daily invocation events and existing monthly weighted-credit events **atomically**: either both counters and event ledgers update or neither.
- DEV file-backed SQLite tests use two separately opened connections: 1 daily call + 5 weighted credits; monthly limit rejection fully rolls back daily, and daily rejection fully rolls back monthly; 16-way same-ID replay admits once; 12-way distinct IDs at 999/1000 admits once; UTC day/month rollover replay and owner isolation; backend outage fails closed.
- Standalone Windows DEV **11/11** tests and TypeScript PASS after adding legacy monthly-only and daily-only event collision rollback assertions. The earlier full 46/46 regression passed before these two additions; exact combined rerun is required. Full combined regression/build, exact GitHub CI and parent PR #498 status to be checked before any merge.
- **Critical gate:** no production integration; trusted monthly tool quote and paid owner entitlements must come from first-party services. All old admission routes must be reconciled before activation or bypass remains possible. Existing monthly-weighted and proposed daily quota cannot be separately charged in live traffic.
- Cloudflare independent Worker/D1 transactional behavior, real token-family revocation, provider row costs and signed canary rollback unverified. See [dual atomic S2 contract](SCALE_V2_S2_DUAL_ATOMIC_QUOTA.md). Both Native Agents and paused paid billing are untouched; S2 remains OPEN.

## Each future status report must record

- **Date/time, issue number, exact commit/branch, affected paths and observable device/production impact.**
- **Current live state versus branch-only state; completed unit tests versus physical/paid/provider acceptance; what is unknown.**
- **Cloud request cost and hard-stop impact (measured, projected, or unknown); SLO impact; branch/CI exact-head link.**
- **Rollback, temporary resource cleanup, and proof both original agents remain reachable where applicable.**
- **Next single actionable slice; blockers and owner approvals required.**

This ledger is updated through reviewed commits/PRs; issue comments store intermediate status without implying merge or deployment.

## 2026-10-15 — S2/S4 Custom Usage disclosure, separate acceptance and draft UX (OFF)

- Owner requires user-facing warning on purchase and signup about provider throughput, selected daily 100..850000 limit, no guarantee of consuming full allowance, 600 requests/minute **shared by Secure MCP Tunnel and calling app**, and versioned terms acknowledgement. The legal text does NOT by itself guarantee platform capacity or extinguish statutory consumer rights.
- From verified post-#510 main `eca9a791eff70dbe3c5ab5379397a6e962b5c633`, isolated branch `test/scale-v2-custom-usage-disclosures-20261015` adds `src/product/custom-usage-disclosures-proposal.ts`: authenticated subject/flow/price/merchant/cancel URL/document revisions/100..850000 quota bound to signed 15m HMAC offer with SHA256 receipt. Separate mandatory terms, limits, purchase pre-information confirmations; separately optional unchecked marketing; KVKK privacy notice is information and **not** bundled blanket consent. DB write failures, stale offers and cross-account price tampering fail closed.
- DEV-only `test/fixtures/scale-v2-custom-usage-disclosures-dev.sql`, `test/custom-usage-disclosures-staging.test.ts`, and **unlinked, nonfunctional production** `web/custom-usage-consent-preview.html` with price/merchant placeholders, disabled payment. `docs/SCALE_V2_S2_S4_CUSTOM_USAGE_DISCLOSURES.md` records KVKK 2026/347 and Turkish distance-sales/contract sources plus production blockers.
- No actual GitHub account creation acceptance hook, checkout gate, provider payment, customer data processing or daily quota change. Live Free remains 1000 weighted/month. Only DEV signing/receipt and UX preview, counsel/content/actual merchant price and provider sandbox required before any enabled consent/billing route.


## 2026-10-15 — Z2 Tailscale Funnel safety preflight, NO NETWORK CHANGES

- Work PC already has Tailscale Running/online/MagicDNS. A sanitized, read-only `tailscale funnel status --json` found **two existing public handlers forwarding directly to old 127.0.0.1:43110 Hub**, which contains /agent as well as /mcp. Neither Funnel nor live Hub/Agents was touched; proposed safer target is localhost MCP-only 43111 from pending PR #509.
- New CLI `nexowire local-first funnel-plan`: calls only `tailscale status --json` and `tailscale funnel status --json`, reports redacted public route counts and safety state with `readyToExpose:false`. Fails closed for missing/unrecognized/unsafe active routes; no new tunnels, DNS, exposure or public endpoint created.
- New `src/mcp/local-first-funnel-plan.ts` and `test/local-first-funnel-plan.test.ts`: 9/9 new tests; combined existing ingress + planner **20/20 PASS**, TypeScript PASS. Work PC real read-only command returned **needs-migration**, two public 43110 handlers, no protected 43111 route. Read-only Hub health: 2 Agents connected, ownerOauthConfigured=false; no public OAuth cutover approved.
- Staged migration/test runbook `docs/SCALE_V2_Z2_TAILSCALE_SAFE_MIGRATION.md`. OpenAI Secure MCP Tunnel default 600/min => 864k/day, so does not meet 10M/day target without explicit authorized limit increase/other provider. Still no remote ChatGPT test, central daily quota conversion, automatic user PC onboarding or cloud bill change.
## 2026-10-15 — S2 Custom Usage 100–850000/day, shared 600/min (DEV, OFF)

- Owner clarified requirement: per-account dynamically scalable **infrastructure capacity** independent from future plan entitlement, daily custom usage selection from 100 through 850000 inclusive, maximum 600 requests/minute when using the *default* OpenAI Secure MCP Tunnel. Actual future Free/Plus/Pro target tiers 1000/5000/10000/day remain **OFF**; deployed Free-only 1000 weighted/month and owner null-credit exception unchanged.
- New independent branch `test/scale-v2-custom-usage-ceilings-20261015` based on verified main `6e23d7014e72e364bd53ed5e0fad53ca662449df`, not stacked on PR #510. Owner-controlled **self-hosted** DEV-only SQLite atomic counter+idempotency and one-minute rolling shared tunnel/application admission model, no Worker/Hub/Agent imports or live release.
- `src/product/custom-usage-owner-meter-proposal.ts`, `test/fixtures/scale-v2-custom-usage-selfhosted-dev.sql`, `test/custom-usage-owner-meter-staging.test.ts`: 13/13 DEV tests PASS for 100..850k integer bounds, daily upgrade/downgrade, 600 accepted/601 denied in a true rolling minute, several users sharing same transport budget, UTC midnight, cross-day replay, verified entitlements, bad clock and no schema fail closed. Synthetic high-usage boundary **NOT** real 850k network load.
- OpenAI default Secure MCP Tunnel 600 requests/minute scope is **shared by tunnel+calling application**, not per each account, and its 864k/day mathematical maximum leaves just 14k overhead against an 850k requested allowance. ChatGPT Plus/Enterprise subscription is not an automatic MCP transport limit waiver. Actual normal ingress calls (auth/discovery/retries) must be counted independently and paid/workspace permission acceptance is still needed.
- Production **NO-GO**: no trusted payment/plan verification, no ingress-wide shared rate limit, no real 850k/day soak, no quota migration, no public Funnel cutover, no hardware load proof, no incremental cloud payment. See `docs/SCALE_V2_S2_CUSTOM_USAGE_850K.md`.


## 2026-10-15 — Z1 local-first MCP loopback ingress (DEV only)

- Isolated branch feat/scale-v2-local-first-ingress-20261015 based on verified main e0bdb80a460eea425aab301ccb45773358c604ca, no active Agent/Hub/Worker deployment. Added opt-in nexowire local-first ingress CLI and src/mcp/local-first-ingress.ts.
- Local-only new ingress at 127.0.0.1:43111 to existing authenticated local Hub at 127.0.0.1:43110, permits only POST /mcp and protected-resource metadata GET; rejects /agent websocket, admin, encoded/query paths, invalid Host/Origin, missing bearer, oversized/concurrent requests and missing Hub. No direct public DNS/tunnel or duplicate Agent started.
- Public-host option requires exact configured HTTPS OAuth resource plus remote metering and read-only existing local Hub OAuth metadata proof. This does NOT prove actual Cloudflare tunnel, token validation, paid plan or any authenticated off-network ChatGPT connection; no permanent hostname yet.
- New Windows isolated HTTP tests 11/11 PASS, TypeScript/build PASS. More tests and GitHub exact-head CI pending before acceptance. Docs: docs/SCALE_V2_LOCAL_FIRST_REMOTE_INGRESS.md.
- NO-GO: no one-click tunnel, per-PC multi-tenant onboarding, trusted local-only commercial quota (tamperable), off-network authorization, global load soak, zero-bill proof, production canary, or in-flight Agent revoke. Existing Free-only monthly policy, both connected Agent v1.0.5 and native Hub/Broker untouched.


## 2026-10-15 — S1 epoch-sensitive access-token verification (isolated DEV)

- Base is verified post-PR #504 main `cf8fc4cdb166f375a1f8dc4e26154550a67d0564`. Worktree `Nexowire-scale-v2-s1-epoch-access-verifier-20261015`, branch `test/scale-v2-s1-epoch-access-verifier-20261015`.
- Added staging-only `src/product/mcp-oauth-epoch-access-verifier-proposal.ts`: single joined read of token hash, current unlocked account generation, legacy account logout gate and historical session-epoch events. Prevents an old token from becoming accepted again if its expiry was restored or the epoch row is missing after historical logout. Identity read is NOT a tool-execution authorization check.
- New `test/mcp-oauth-epoch-access-verifier-staging.test.ts` verifies 14 scenarios (including atomic refresh -> verify -> logout -> fresh reauth -> old token denied). **14/14 new, 56/56 combined S1 OAuth Windows DEV tests PASS**, TypeScript/build PASS. An initial missing-epoch history test caught a fail-open gap and was corrected before commit.
- Cloudflare attempt: connected SentinelX had no configured Cloudflare integration or D1 management scope; Work PC showed no `wrangler` command or Cloudflare environment variable names; an isolated Cloudflare dashboard headless session met a bot challenge and was not bypassed. No remote Cloudflare SQL, D1 staging provisioning, production migrations or settings changed.
- Documented exact scope and D1 staging acceptance prerequisites in `docs/SCALE_V2_S1_EPOCH_ACCESS_VERIFIER.md`. **NO-GO**: live OAuth verifier/issuer not epoch-aware, first-party fresh login not wired, real D1 cross-Worker transactional and read-consistency proof/cost and in-flight device/owner guard missing.
## 2026-10-15 — S1 atomic authorization-code consumption + issuance (isolated DEV)

- New isolated branch `test/scale-v2-s1-atomic-code-redemption-20261015`, based on PR #504 verified merged main `cf8fc4cdb166f375a1f8dc4e26154550a67d0564`, **not** stacked on unfinished #505.
- `test/fixtures/scale-v2-s1-oauth-atomic-code-staging.sql` stages one nested-trigger SQLite INSERT to compare-and-swap consume a bound, valid, PKCE-verified authorization code and insert access + optional refresh hashes in a **single atomic statement**, respecting current unlocked session generation.
- Standalone `src/product/mcp-oauth-atomic-epoch-code-proposal.ts` validates SHA-256 PKCE, configured resource and persisted code/client/redirect/scopes/epoch, refuses replay and unknown commit acknowledgement. The real OAuth redirect canonicalizer, state/nonce and first-party identity are **not** wired.
- New `test/mcp-oauth-atomic-epoch-code-staging.test.ts`: **9/9 Windows DEV SQLite cases PASS** for valid and no-offline-access grants, replay, 16-way contention, PKCE/client/redirect/resource mismatch, logout/expiry, collision rollback, and provider lost ACK. `npm run typecheck` PASS. See `docs/SCALE_V2_S1_ATOMIC_CODE_REDEMPTION.md`.
- No active Cloudflare D1 login/provider proof. Production OAuth exchange path unchanged; no live Hub/Agent/Broker restarts, paid/daily plan gates or D1 production migration.


## 2026-10-15 — S1 atomic session-epoch refresh rotation (DEV-only, stacked)

- New isolated worktree `Nexowire-scale-v2-s1-atomic-epoch-refresh-20261015`, branch `test/scale-v2-s1-atomic-epoch-refresh-20261015`, based on unmerged S1 session epoch PR #503. No production OAuth imports, changes to deployed migrations, or Native Agent service actions.
- `test/fixtures/scale-v2-s1-oauth-atomic-refresh-staging.sql` creates one SQL INSERT + nested trigger to consume current-epoch old refresh and issue new access+refresh pair atomically; rejects locked/outdated epochs and invalid OAuth account/client/resource/scope or duplicate/colliding IDs.
- `src/product/mcp-oauth-atomic-epoch-refresh-proposal.ts` exposes a default-unwired, trusted-resource standalone adapter. It validates persisted owner/epoch/scope, generates server-only random credentials and returns them ONLY after acknowledged SQL reservation; ambiguous writes must not be retried.
- `test/mcp-oauth-atomic-epoch-refresh-staging.test.ts`: **9/9 new Windows DEV SQLite tests PASS**, including 16 parallel replays, two separately opened file-backed SQLite connections, collision rollback and simulated committed-but-unacknowledged provider response. PR #503 merged as `93818fb3cced93a3c3b80b13dcd0efeae1f45d67`; PR #504 was cleanly rebased onto that verified main and remains staging-only. See `docs/SCALE_V2_S1_ATOMIC_EPOCH_REFRESH.md`.
- **Still NO-GO:** original OAuth issuer and access verifier are not migrated, first-party browser reauth proof is injected, tokens could be orphaned after a lost remote success response, existing in-flight tool permissions and provider D1 cost/canary have not been accepted. No live session touched.


## 2026-10-15 — S1 OAuth monotonic session epoch and safe re-login (isolated DEV)

- Parent #502 has exact HEAD `edcbeb07c0f167a1e55af5732f578b5782929616` and full 7/7 GitHub CI; it remains DRAFT while hard account-lock recovery is unresolved. This slice is in a new isolated `test/scale-v2-s1-oauth-session-epoch-20261015` branch stacked on #502.
- New STAGING fixture `test/fixtures/scale-v2-s1-oauth-session-epoch-staging.sql`: backfills old permanently locked accounts, then models a monotonic account generation and compares expected generation atomically. New access/refresh/auth-code writes require the current unlocked epoch; legacy epoch-0 issuance fails closed once an account has logged out. A trusted new reauth increments the generation, rather than removing the audit lock without fencing old credentials.
- New `src/product/mcp-oauth-session-epoch-proposal.ts` enforces injected independent **fresh first-party login** authorization, owner match, global stable operation-ID and fail-closed errors. **No production Worker imports or OAuth route changes.**
- Windows DEV: 13 new session-epoch cases PASS; 33/33 combined S1 OAuth regressions PASS, TypeScript/build/continuation/launch audit PASS. SQLite mocks are not Cloudflare Worker/D1 acceptance. Documented in `docs/SCALE_V2_S1_OAUTH_SESSION_EPOCH.md`.
- **NO-GO:** existing `McpOAuthService.issueTokens`/D1 writers and verifier still lack session-epoch integration; token rotation itself is not atomic with issuance, first-party reauth provider is injected test-only, in-flight device/tool permissions and deployed migration rollback remain unresolved. Production auth/Agent/Hub/Broker stays unchanged.


## 2026-10-15 — S1 OAuth account-wide lock and revocation (DEV proposal)

- Isolated worktree `Nexowire-scale-v2-s1-oauth-logout-staging-20261015` branch `test/scale-v2-s1-oauth-logout-staging-20261015`; based on merged main `9624ad2651948b89b29c7c85537082410dcb7ea9`. **Production untouched**.
- `test/fixtures/scale-v2-s1-oauth-logout-staging.sql`: one owner-account INSERT plus nested trigger atomically expires existing access tokens, revokes every refresh token and consumes pending auth codes. Other-account tokens unaffected. Additional staging triggers block new tokens/codes from a locked owner, closing issuance-after-logout race.
- `src/product/mcp-oauth-account-logout-proposal.ts`: trust-only owner-authenticated fail-closed logout adapter with stable duplicate semantics, unknown provider error never a grant; no Worker route. Seven DEV SQLite regression tests PASS and typecheck PASS. See `docs/SCALE_V2_S1_OAUTH_LOGOUT_STAGING.md`.
- **BLOCKING**: this is a hard lock; real customer re-login is disallowed by the prototype. Need server-authenticated session-epoch/family generation, safe relogin with no stale-refresh race, in-flight permission revocation and Cloudflare D1 proof before even proposing deployment. Do not confuse this with complete, customer-ready token family logout.


## 2026-10-15 — S2 trusted joint-admission orchestration (isolated DEV only)

- Worktree: `Nexowire-scale-v2-s2-trusted-dual-admission-20261015`, branch `test/scale-v2-s2-trusted-dual-admission-20261015`, based on PR #499 HEAD `d767a8c62cb5e69b6c4c42384642e4a7dc09dc25`. **Not deployed**.
- New `src/product/trusted-dual-admission-proposal.ts`: mandatory fresh authority gate before server-resolved quota subject/entitlement, canonical monthly usage credits and **one** atomic daily/monthly reservation, using legacy-stable hosted MCP event ID. No split charge, no legacy fallback and no tool execution.
- New 11-case negative/positive test for role denial, paid OFF, forged client tier/cap, 5x skill, replay/denials, D1 errors and rollover. Combined **47/47 S2 Windows DEV** tests PASS; TypeScript, build, continuation and AI Screen launch audit PASS. Local SQLite and injected mocks **are not** Cloudflare provider evidence.
- Documentation: `docs/SCALE_V2_S2_TRUSTED_DUAL_ADMISSION.md`. Blocking: real OAuth owner+device guard and in-flight revocation, exclusive server charge path, old monthly-only invocation replay crossing month and quota subject, full token-family revoke, real Worker/D1 concurrency and owner spend/rollback gates.
- PR #499 exact HEAD CI initially **6/7**: `browser-live` Windows Edge profile `lockfile` cleanup failed `EBUSY`. One failed-job re-run on existing run `38707694064`; no merge while unresolved. Both Agent routes, current production quota, paid checkout and D1 production schema untouched.

## 2026-10-15 — S2 historical global replay fence / closed old mutation paths (isolated DEV)

- New standalone worktree `Nexowire-scale-v2-s2-global-replay-cutover-20261015`, branch `test/scale-v2-s2-global-replay-cutover-20261015`, based on the S2 admission draft HEAD `980fbc373569b3343dc0724feb525f2d1a234ea1`. Not a live migration.
- New `test/fixtures/scale-v2-global-replay-cutover-staging.sql` stages global canonical `mcp-` event replay PK, backfill from existing monthly and daily events, dual reservation nested trigger and explicit closure for standalone monthly/daily hosted MCP writers. Backfill uses transactional abort on historical duplicates; does not silently ignore clashes.
- New `test/global-replay-cutover-staging.test.ts`: **8/8 Windows DEV SQLite tests PASS** for prior-month replay, subject switch, old path closure, duplicate history rollback, daily-only historical backfill, combined legacy pair and noncanonical ID. TypeScript PASS. Documented in `docs/SCALE_V2_S2_GLOBAL_REPLAY_CUTOVER.md`.
- These tests prove local file-backed SQLite semantics only, NOT actual provider D1 multi-Worker or unrecorded historical ID completeness. Production requires upstream one-route fencing, signed canary, full OAuth/token-family revocation, old in-flight drain, provider cost and explicit owner-approved migration. Live monthly Free-only quota and both Agent routes remain unchanged.
