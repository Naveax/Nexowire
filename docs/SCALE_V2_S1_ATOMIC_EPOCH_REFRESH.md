# Scale v2 S1: one-statement epoch-bound refresh rotation (DEV/STAGING)

**2026-10-15 | Issue #483 | Draft PR #504, rebased onto merged PR #503.** This is a deliberately UNWIRED experimental implementation. It is NOT a production OAuth endpoint, paid feature, Cloudflare D1 migration or Agent update.

## Defect addressed

The current live `McpOAuthService.exchangeRefreshToken` consumes the old refresh token and then calls `issueTokens` in a **separate** operation. A failure between these writes can strand a legitimate account's session. PR #503 prototypes monotonic account epochs and an independent, authenticated re-login, but the existing issuer is not epoch-aware and must remain excluded after account logout.

This slice adds `test/fixtures/scale-v2-s1-oauth-atomic-refresh-staging.sql`, loaded only in SQLite tests after S1 logout and session-epoch fixtures. A **single top-level INSERT** into `mcp_oauth_epoch_refresh_rotations` atomically:

1. Validates current account generation is unlocked and equals the prior token's epoch.
2. Confirms the prior refresh token exists, has not been revoked or expired and has matching account, OAuth client, resource and unchanged scopes.
3. Revokes that prior refresh token by compare-and-swap, requiring exactly one affected row.
4. Inserts both new access and new refresh token hashes in the **same statement** and same generation.

Any rejection, duplicate old refresh hash, concurrent logout, stale epoch, unique collision or nested token-insert failure must roll back *all* effects of that insert. No split post-charge or hidden retry.

`src/product/mcp-oauth-atomic-epoch-refresh-proposal.ts` is a standalone adapter. It hashes token secrets, derives owner/scopes/epoch from D1 and the trusted resource from first-party configuration, generates new unpredictable token values on the server and exposes them only on an acknowledged successful reservation. It refuses ambiguous database acknowledgements, does not retry an old refresh token, and never uses client-supplied plan/owner/epoch. This code is not imported into the existing issuer or Worker.

## Windows DEV proof

`test/mcp-oauth-atomic-epoch-refresh-staging.test.ts` has 9 tests:

- Successful one-step generation-2 rotation creates one usable access token and one new refresh token, preserving scope.
- Repeated and 16 simultaneous same-refresh attempts mint **one** pair.
- Two independently opened connections to the same WAL-backed SQLite file race the same refresh: exactly one pair is issued and only one old refresh is consumed. This is still NOT independent Cloudflare Workers.
- Forged OAuth client/resource cannot charge/issue, and logout/epoch rollover prevents stale rotation.
- A deliberately colliding next access-token hash **rolls back** prior refresh consumption and both new token writes.
- When a fake provider reports a missing acknowledgement **after committing**, no success/token is returned and a second call is refused.

These are local SQLite and software-contract tests. They are NOT real Cloudflare D1 under separate Workers, nor proof of provider-billed rows, p95, outage recovery or absence of orphaned credentials after lost remote replies.

## Blocking before adoption

- This adapter remains **unwired**; existing production `McpOAuthService` and D1 token store are unchanged. An approved replacement must unify authorization-code issuance, access-token verification, refresh rotation and re-login with the same versioned epoch/family protocol. In-flight mutation/device permission checks still require a separate barrier.
- Real first-party proof of fresh login, OAuth client/resource binding, migration/backfill completeness, expiry normalization, account/device token family policies and session recovery UX require review.
- A lost remote success response can strand **raw new token values** because only token hashes are stored. It safely refuses execution/replay, but the client must reauthenticate; no exactly-once external-delivery claim.
- Need real Cloudflare D1 staging concurrency, transactional trigger compatibility, provider errors, cost hard-stop, rollback, security review and explicit production authorization.
- Live Agent v1.0.5 services, current Free-only monthly quota, payment gates and all Cloudflare migrations remain untouched.
