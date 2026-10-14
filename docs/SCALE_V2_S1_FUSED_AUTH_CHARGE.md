# Scale v2 S1: one-request OAuth authorization plus atomic quota reservation

> **2026-10-15 candidate; default OFF / not deployed**. Parent [#483](https://github.com/Naveax/Nexowire/issues/483) and master [#482](https://github.com/Naveax/Nexowire/issues/482). Source evidence [S1 fan-out](SCALE_V2_S1_WORKER_INGRESS_FANOUT.md).

## Why this change exists

Existing hosted single-tool MCP path performs a Worker call for OAuth token authentication and another Worker call for quota charging. Both are still required security checks. The combined handler **does not skip either check**: it performs them behind one trusted service-only HTTP boundary, reusing the existing server-side OAuth verifier, current account/device store, tool role policy, existing `ControlPlaneService.chargeUsage()` and D1 atomic ledger.

### New isolated component

`src/product/fused-mcp-authorize-charge.ts` exposes `createFusedMcpAuthorizeChargeHandler(deps)` for an internal `POST /api/v1/internal/mcp/authorize-charge`. Accepts exactly the bounded bearer access token, one explicit `invocationId`, one `toolName`, and optional boolean `specialSkill`; no account, quota subject, role, plan or device permission from caller is trusted.

Order, all required:
1. Independently authenticate the **service** bearer through `authenticateService`.
2. Validate bounded request; verify current OAuth access token **and mcp scope** through the existing store; look up the current account.
3. Enforce current role restrictions (including operator/admin-only tool controls). No quota reservation on an unauthorized tool.
4. Obtain current account-owned device/folder lists, access modes and AUTO selection settings. Do not cache or trust Hub-supplied permissions.
5. Derive the existing `hostedMcpUsageEventId(accountId,invocationId)` server side and call the exact existing atomic quota charge ledger. On duplicate return 409; feature denial 403; exhausted quota 429. Failed/unknown DB state remains 503, **never execute and never grant free usage**.
6. Only on successful charge return the owner-bound scope projection and charged status. Never echo access tokens, SQL or arbitrary exception strings.

## Inactive Worker integration

`cloudflare/worker.js` imports the helper but hardcodes `PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED = false`. The new route is **unreachable** in the production router, and cannot be toggled by an environment variable. Existing `/api/v1/internal/mcp/authenticate` and `/api/v1/internal/usage/charge` still operate unchanged. No Hub client switch, user quota migration, live deployment, service restarts, broker privilege adjustment or billing activation was performed.

The direct tests use an isolated `MemoryControlPlaneStore` with real `ControlPlaneService` atomic charge behavior and mocked OAuth issuer. They validate exact shared idempotency namespace with the existing metering code, independent fresh OAuth checks on every call, tool-role and Free feature denial, quota exhaustion, no cross-account charge, error hiding, and concurrent identical invocation IDs. These are local tests, **not a multi-Worker D1 concurrency proof**.

## Remaining acceptance gates before any live switch

- [ ] Stage a first-party Hub client method that receives and strictly validates the combined authorization and quota decision in one remote Worker fetch; preserve existing local/self-hosted MCP auth paths.
- [ ] Test real OAuth token store (expiry, revocation, resource, scope), real D1 adapter under contention across **independent database connections/Worker instances**, concurrent 999/1000 boundary, UTC month rollover, cross-tenant replay, failed DB/HTTP timeouts.
- [ ] Compare accepted/denied/duplicate/unauthorized tool paths before and after switching; no unauthorized charges and no double execution, including role and device revocation between requests.
- [ ] Add staging-only opt-in on **both** client and server with secure failure on unsupported server, tested rollback. No silent fallback that could re-run an already reserved mutation.
- [ ] Obtain provider request totals, D1 row read/write and p95 latency measurements under authorized staging only; check realistic free-tier cost budget and production safety signoff.
- [ ] Recheck both preexisting Work PC and Naveax agents without restarting them. Maintain #271 deferred privileged cutover.

## Commands

```sh
npm run typecheck
npm run build
node --check cloudflare/worker.js
node --test --import tsx test/fused-mcp-authorize-charge.test.ts test/fused-mcp-worker-default-off.test.ts test/hosted-metering.test.ts test/control-plane-mcp-auth.test.ts
npm run ai-screen:launch-audit
```

**No full S1 acceptance or one-request production savings claim is justified by this implementation.**
