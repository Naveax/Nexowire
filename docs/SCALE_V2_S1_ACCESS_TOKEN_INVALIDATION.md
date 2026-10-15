# Scale v2 S1 — Owner-scoped single access-token invalidation

> **DEV-only service/store capability. Not exposed as an endpoint, not deployed or invoked by a live session.** Parent [#483](https://github.com/Naveax/Nexowire/issues/483). This is an interim primitive, **not a complete logout/revoke-all-sessions implementation**.

## Precise behavior

`McpOAuthService.invalidateAccessToken(accessToken, authenticatedAccountId)` takes an OAuth access token and an **independently authenticated owner account ID**. The caller may not use a client-supplied account ID without owner verification. It validates the token format and asks the configured store to conditionally expire the token using only its SHA-256 token hash, expected account ID and current issuer timestamp. It does not log or return the original token.

- `D1McpOAuthStore.invalidateAccessToken` uses an **atomic conditional SQL UPDATE**: `expires_at = now` only when token hash AND account ID match and `expires_at > now`. Existing deployed DB columns suffice, no new schema or migration. SQLite adapter test checks 12 concurrent calls yield exactly one success.
- `MemoryMcpOAuthStore.invalidateAccessToken` follows the same owner/expiry condition without an async gap between read and update.
- Existing `McpOAuthService.authenticateAccessToken` already denies `expires_at <= now`, so subsequent authentication checks immediately reject the invalidated token. This automatically applies to the compile-time OFF fused handler whenever it verifies the real first-party OAuth service.
- If the account differs, token is unknown/already invalidated/expired, or its syntax is invalid, the service returns `false` without invalidating a different account's token.
- This is **not** a new user-facing OAuth revocation endpoint; no Worker route or Hub changes, no Agent restart and no change to the monthly Free-only quota or paused billing.

## Security limitations and required follow-up

1. Expiry-based invalidation **does not record a separate revocation reason/time** for audit. It is intended as a narrow immediate denial primitive while a complete revocation scheme is designed.
2. Existing **refresh token remains valid** and can mint another access token. A logout or account revoke-all action must revoke refresh and access token families (or implement a server-side session generation and enforce it on each trusted request), plus prevent future token issuance. Do not call this method a full session logout.
3. An authentication that already completed before invalidation may have proceeded to charge/execution. Cancellation of already-in-flight mutations needs separate task/session policy.
4. Remote Worker/D1 races under *independent processes/connections* are not established by a single in-memory SQLite process. Re-run under real D1 staging with proper owner approval and a bounded usage budget.
5. No owner permissioned endpoint or UI exists. A future handler must independently authenticate and authorize the owner, protect against CSRF where applicable, and never allow arbitrary account IDs or raw tokens in logs.
6. Separate *per-device permission revocation* remains a required contract for full S1; this primitive does not solve it.

## Local verification

```sh
node --test --import tsx test/mcp-oauth.test.ts test/mcp-oauth-d1.test.ts test/fused-mcp-authorize-charge.test.ts
npm run typecheck
npm run build
npm run ai-screen:launch-audit
```

Memory and D1 tests verify owner-bound denial, immediate auth rejection, parallel conditional update and replay denial. A memory test explicitly demonstrates that **refresh can still issue a new token**, documenting rather than hiding the unsolved session-revocation gap.

The feature is not enabled on production and no user or service credential was accessed.
