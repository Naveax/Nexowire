# Scale v2 S1 — Hosted MCP ingress fan-out evidence (DEV)

> **2026-10-15** | Tracks [#483](https://github.com/Naveax/Nexowire/issues/483), [#482](https://github.com/Naveax/Nexowire/issues/482), and [S1 quota/cost model](SCALE_V2_QUOTA_AND_COST.md). **Source-path and mock-fetch evidence only.** No production Cloudflare usage, user token or provider billing metrics accessed.

## Finding: normal hosted MCP tool execution makes two control-plane HTTP requests

The current `src/mcp/http.ts` calls `resolveMcpAuthorization` on the inbound `/mcp` request. A correctly formed hosted `nwx_mcp_...` bearer is sent by `ControlPlaneMcpClient.authenticate` to the Worker endpoint `POST /api/v1/internal/mcp/authenticate` (one remote request), validating current user/device authorization and access policy.

After checking tool permissions, `enforceHostedMcpMetering` runs for each tool call and invokes `ControlPlaneMcpClient.chargeTool`, posting to `/api/v1/internal/usage/charge` (one additional remote Worker request), with existing exact invocation-ID replay/charge rules. An accepted hosted single-tool invocation therefore normally generates **2 remote Worker fetches**, not one.

`test/scale-worker-capacity-model.test.ts` executes the actual `resolveMcpAuthorization`, `ControlPlaneMcpClient`, and `enforceHostedMcpMetering` methods with an in-memory fake `fetchImpl`. It asserts the exact two Worker paths, and confirms a repeat ID is denied with `MCP_DUPLICATE_REQUEST` rather than silently executed. It does not use real account identities or network access.

**Do not extrapolate to all requests:** invalid/absent hosted credentials, health/policy endpoints, list-only MCP operations, local static credentials, device presence and reconnect have different paths. No external Workers request-meter, D1 billed read/write row meter, or traffic sample was queried. Other per-user ingress, retry and signaling requests will increase cost.

## Capacity model and boundary

`src/ops/scale-worker-capacity-model.ts` is a pure deterministic scenario estimator with explicit assumptions: active users, hosted invocations/user/day, auth Worker calls per hosted tool, charge Worker calls per hosted tool, per-user background calls, fixed requests, retry fraction (per-mille) and a **hypothetical** Worker daily request budget. Inputs require bounded safe integers, with overflow rejection. The binary-search helper estimates a maximum user count under the supplied finite scenario.

Using a **hypothetical 100,000 Worker requests/day** and the current hosted tool path's *two* remote requests/accepted tool call, no background overhead and no retries:

| Active users | Tools/user/day | Auth + charge Worker requests/day | Headroom |
| ---: | ---: | ---: | ---: |
| 10 | 1,000 | 20,000 | 80,000 |
| 50 | 1,000 | 100,000 | 0 |
| 100 | 1,000 | 200,000 | -100,000 |
| 1,000 | 1,000 | 2,000,000 | -1,900,000 |

This does not represent a live Free tier, current provider capacity, actual payment plan or guaranteed cost. The existing Free-only runtime is still **1,000 weighted units per UTC month**, with paid checkout paused. The future daily Free/Plus/Pro numbers are proposals only. The model cannot issue entitlements or lift quotas.

## Candidate optimization (P0 discovery, NOT IMPLEMENTED)

Consolidate authentication, device/tool authorization and **atomic** quota reservation into a single server-side authenticated control-plane operation, reducing two sequential hosted Worker requests toward one for that path, **without** opening an unmetered bypass. Security acceptance must prove:

- Current access token, device scopes, owner/org and **revoked** permissions are always checked in the *same* trusted operation; no unsafe cached auth.
- The quota subject is server-computed; client cannot select another user's quota.
- The ledger atomically stores invocation ID+digest and checks it on replay *before* execution.
- Duplicate tool execution is rejected; network failure and ambiguous mutation state remain fail-closed.
- Parallel reservation, UTC rollover, forged payload and revoked token tests remain green.
- Provider Worker + D1 operations and request latency are compared against the prior two-request implementation under matched synthetic tests.
- Repeated retries and external ChatGPT MCP ingress never become unbilled or free due to P2P.

**No implementation or deployment of the combined endpoint in this PR.** Do not consolidate APIs without the above tests; reducing 2 calls to 1 is a *target*, not established cost savings.

## Next bounded slice

1. Instrument mock/in-memory Worker handler and D1 with opt-in fixed counters from staged PR #490, then verify behavior when quota exhausted, auth denied, or request replayed.
2. Compare mock request cost before/after any authorized combined method, including D1 row estimate limitations.
3. Stage a privacy- and spend-guarded workload test and acquire actual Cloudflare billing counters only after deployment consent.
4. Preserve existing Work PC / Naveax Agent v1.0.5 connections and the #271 privileged-runtime hold.
