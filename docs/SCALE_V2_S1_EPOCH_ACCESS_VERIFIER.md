# Scale v2 S1 — OAuth access-token epoch verifier (DEV/staging only)

Date: 2026-10-15. Scope: issue #483. This proposal is **not** imported into any live Worker/OAuth route and does **not** alter `cloudflare/migrations`. Existing Free-only monthly quota, payment flags, Agents and Hub/Broker remain unchanged.

## Problem and proposed request-level guard

The current `McpOAuthService.authenticateAccessToken` verifies token hash, resource, MCP scope and expiry, but does not check whether its account's OAuth session epoch has changed. A future valid-looking access token could be accepted after logout/re-login if expiry is incorrectly restored or a stale writer bypasses invalidation.

The new `src/product/mcp-oauth-epoch-access-verifier-proposal.ts` executes one joined read of:
- hashed access credential, its owner, OAuth client/resource/scopes, issuance/expiry and `session_epoch`;
- `mcp_oauth_session_epochs` current `generation` and `locked` gate;
- `mcp_oauth_account_logout_gate` legacy revocation evidence; and
- `mcp_oauth_session_epoch_events` history to refuse legacy epoch-zero fallback if a current-generation row is missing.

An access token is admitted only if current generation matches token generation, is unlocked, resource exactly equals first-party configuration, contains MCP scope, timestamps are valid and no operation-level error occurs. Generation-zero tokens can be admitted only for a *never transitioned* legacy account, not one with logout/audit history.

**Do not cache the returned identity**. It represents authentication at the time of that single read, not an owner/device permission grant for executing a tool. The read cannot undo an already-running tool or prevent revocation immediately after the query. The live authorization+device checker and mutating-tool reservation must have a separate current-permission barrier.

## Local evidence

- 14/14 new verifier regression cases PASS and **56/56 total S1 OAuth regressions PASS** on Windows Node 22+ local SQLite, `npm run typecheck` PASS.
- The regression cases cover: legacy epoch zero, expired/invalid token and scope/resource rejection, account separation, logout and repeated independent re-login, corrupted/future token timestamps, missing epoch after historical logout, generation mismatch, provider outage fail-closed, replayed old token, no cache across requests and real proposal-level atomic-refresh access→verify→logout→relogin denial.
- The failed initial corruption-history test correctly exposed the need to consult the append-only `mcp_oauth_session_epoch_events` history in addition to legacy logout gate. After fixing that guard, all 56 tests passed.

## Cloudflare verification attempted

The user authorized Cloudflare site changes. However:
- Connected SentinelX exposes DNS/Access-style Cloudflare controls, **not D1 management**; its Cloudflare integration returned `integration_not_found`.
- Neither accessible Work PC nor the other Nexowire machine exposed a `wrangler` command in the shell. Work PC had no named Cloudflare/Wrangler API environment variables; **these checks do not rule out other credentials elsewhere**.
- A dedicated isolated headless Edge browser opened `https://dash.cloudflare.com/` and received a bot-verification challenge. No login, bypass, remote SQL, database creation, settings change or live migration was performed.

Thus **NO Cloudflare provider-side transaction, consistency, rate/cost or staging rollout evidence** is available from these checks. Do not infer D1 support from SQLite success.

## Required provider staging acceptance and safe sequence

1. Obtain an explicitly authenticated Cloudflare D1-capable connection (authenticated dashboard or a short-lived Wrangler login on the owner-controlled machine). Never expose API tokens, cookies, session values or logs containing secrets.
2. Verify account, database names/bindings and any active production resources **read-only**. Separate a clearly labeled scratch/staging D1 database; ensure it is not bound to production Workers or current user sessions.
3. Capture owner-approved cost/row/spend limits, remote operation cap, expiry/cleanup plan, rollback and baseline before provisioning any remote resource.
4. Apply only the three test fixtures in dependency order to that disposable staging database: account-wide logout, monotonic session epochs, atomic refresh. **Do not copy fixtures into `cloudflare/migrations` or execute them against the `nexowire-control-plane` production D1.**
5. Use separate Worker requests to test: concurrent refresh same token admits at most once; failed nested inserts roll back old refresh consumption; logout vs refresh fails closed; an older token is rejected after a fresh first-party login; historical event deletion/compaction never reopens legacy epochs. Verify D1 Sessions/Bookmarks/replica consistency guarantees with actual provider behavior.
6. Record redacted response codes, latency percentiles, rows read/written, query metadata and any billable usage; stop before spend cap. Exercise degraded provider, lost ACK, rollback, cleanup and live Worker-route bypass detection.
7. Only after independent security review integrate the **entire** issuer/authorization-code/refresh/access verification/token-family/device-owner and in-flight mutation gate; require exact-head CI and an owner-approved rollback-ready release.

**GO/NO-GO:** DEV code review only. The authenticated production OAuth issuer and verifier do not use this proposal. Missing D1 remote proof and first-party fresh reauth remain release blockers.
