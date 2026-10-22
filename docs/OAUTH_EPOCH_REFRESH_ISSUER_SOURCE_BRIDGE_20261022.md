# #07: minimal OAuth issuer → atomic refresh integration gate

**Parent:** DRAFT #721 exact `aa16d3e0fc2627960be9a51ad7bba30f0e9ac87d`, whose Actions run `39676732876` completed **7/7 SUCCESS** after only the cancelled macOS job was retried.

## Source change

`McpOAuthService.token()` is the source issuer used by `/oauth/token`. Before this change, the issuer always handled refresh using separate legacy `consumeRefreshToken` and `issueTokens`. Existing `ProposedMcpOAuthEpochAtomicRefresh.rotate()` was tested but **not connected to the issuer**. This child adds an explicit, **server-only** `refreshMode: 'epoch-atomic'` and injected `epochAtomicRefresh.rotate()` to the real issuer service.

When selected, the single trusted atomic adapter validates the stored owner, client, scope and resource; consumes the old refresh and mints the next pair in one staged D1 SQL/trigger transaction, under the present unlocked owner epoch. The issuer **never** falls back to legacy refresh after denial, missing acknowledgement, malformed returned token pair, SQL outage or ambiguous commit. Known invalid/revoked/locked grant denials become `invalid_grant`; unknown infrastructure errors retain server-error status without leaking internal values. A mode configured without an adapter or an adapter without explicit opt-in fails startup.

Default legacy mode is unchanged for existing deployments and tests. **This does not itself switch production to epoch-atomic mode.**

## Negative source QA

`test/oauth-first-party-logout-epoch-refresh-integration.test.ts` now routes the already-existing real SQLite staging logout/refresh fixture through `McpOAuthService.token()`, confirming eight revoked-owner concurrent refresh requests fail closed after logout, the foreign owner remains unaffected, and no extra access tokens are minted. Additional tests prove an explicitly selected but missing authority fails startup, an unknown D1 outage never triggers legacy fallback/replay, a syntactically plausible but malformed adapter receipt is rejected, and wrong resource/invalid client cannot dispatch the adapter.

Existing issuer key rotation, abandoned-browser state, cross-owner CSRF and Windows CORE/ROOT separation tests are left intact, not cloned.

## Hard NO-GO

**No Cloudflare Worker, live token, DNS, Agent, Windows UAC, Broker, VM or D1 migration changes.** This child is source-only; its parent #721, #697 and #675 are still draft. The staging atomic SQL and owner-epoch fixtures are **not deployed**. Required before any production toggle: reviewed D1 migrations, trusted issuer injection, **epoch-aware access verifier**, atomic/owner-epoch-aware auth-code issuance, real logout session and refresh-authority integration, external D1 CAS under concurrency, physical real ChatGPT/Codex login and rollback evidence.

Merely wiring refresh rotation is **not** full session revocation, and OAuth Bearer grants are **not** Windows CORE HIGH tokens or locally approved privileged Broker permissions. Do not merge this child to main independently or deploy this source until those gates pass.
