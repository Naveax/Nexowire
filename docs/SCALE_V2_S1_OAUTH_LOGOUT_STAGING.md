# S1 OAuth account-wide logout and issuance lock (STAGING-ONLY)

**2026-10-15, DEV prototype; issue [#483](https://github.com/Naveax/Nexowire/issues/483), master [#482](https://github.com/Naveax/Nexowire/issues/482).** No production migration, OAuth route registration, account locking or Agent/Hub changes.

## Problem confirmed in existing code

`McpOAuthService.invalidateAccessToken` invalidates only one account-owned **access** token. The existing `exchangeRefreshToken` can rotate a still-valid refresh token and issue a new access token. Single access-token revocation is NOT account-wide logout, nor refresh-token family revocation. Existing `mcp_oauth_access_tokens`, `mcp_oauth_refresh_tokens` and `mcp_oauth_codes` each contain owner `account_id`, but no persistent session/family ID or permission epoch.

## Experimental hard-stop design

- `test/fixtures/scale-v2-s1-oauth-logout-staging.sql`, loaded only in disposable SQLite tests, creates an account-keyed logout gate.
- A **single INSERT** into that gate triggers account-scoped expiry of **every** access token, revocation of **every** refresh token and consumption of pending authorization codes. Nested updates roll back together if any statement fails.
- `BEFORE INSERT` SQL triggers deny any newly minted access token, refresh token or authorization code for a locked account. This prevents a racing pre-logout refresh flow from minting a new token after the logout gate commits (though it does NOT cancel commands already executing).
- `src/product/mcp-oauth-account-logout-proposal.ts` accepts only a trusted already-authenticated first-party caller and a matching target account, a bounded stable logout ID and trusted timestamp. Cross-account mutation is denied. Duplicate and ambiguous commit outcomes NEVER authorize a tool; unknown DB errors fail closed.
- **Very deliberate limitation:** This currently places the account in a permanent lock until a future carefully reviewed, server-authenticated re-authorization/session-epoch mechanism exists. It is NOT suitable for real customer logout or production rollout. Merely deleting this marker would defeat lineage guarantees; a versioned family/session epoch with concurrent refresh/authorization fencing is needed.

## DEV verification

`test/mcp-oauth-account-logout-staging.test.ts` uses actual D1-compatible base schema in disposable local SQLite and tests: one account with two session families, other-account isolation, duplicate logout, simultaneous late issuance blocked, actual `McpOAuthService` access/refresh validation after logout, provider outage fail-closed and explicit new-login lock. **7/7 tests PASS**, TypeScript check PASS.

## Remaining acceptance

- Design safe per-family and account logout with **fresh re-auth**/family generation that cannot race stale token minting; idempotent owner-authenticated D1/Worker boundary. Existing tokens from pre-migration sessions need versioned mapping.
- Verify real Cloudflare D1 concurrency/trigger results, validated token/session headers, cookie/session invalidation, account-ownership verification and in-flight device permission races.
- Distinguish global account logout from device-specific or app-specific disconnect, and preserve the user's signed-in reinstall experience.
- All production routes/flags, migration directories, pricing and both Native Agent v1.0.5 connections remain untouched.

**No production enablement, no Cloudflare paid use, no Agent restart, and no claim of completed S1 token-family revocation.**
