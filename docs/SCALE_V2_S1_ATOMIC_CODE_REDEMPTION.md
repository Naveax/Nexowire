# Scale v2 S1 — Atomic authorization-code redemption (DEV/STAGING only)

**2026-10-15 | S1 issue #483 | NOT LIVE.** Dedicated standalone staging proposal based on main `cf8fc4cdb166f375a1f8dc4e26154550a67d0564`. No existing OAuth route, Worker, payment, quota, production migration or Native Agent is changed.

## Problem

Current `McpOAuthService.exchangeAuthorizationCode` verifies OAuth/PKCE bindings, performs `consumeAuthorizationCode`, and **then** `issueTokens` with separate token writes. If a later token insertion fails, the authorization code may already be consumed and a legitimate OAuth login stranded. The previously merged S1 atomic refresh handles a different grant type; authorization code exchange requires its own atomicity boundary.

## Staging design

- `test/fixtures/scale-v2-s1-oauth-atomic-code-staging.sql` defines a one-top-level-INSERT **SQLite trigger**. It verifies the account has a current **unlocked** session epoch, the code is unused, unexpired and bound to the same account, client, resource, exact redirect URI, SHA-256 PKCE challenge, scopes and generation.
- The trigger updates `mcp_oauth_codes.consumed_at` with compare-and-swap, then inserts one access-token hash, and inserts a refresh-token hash **only** when the original scopes include `offline_access`. The whole insert must roll back together after unique collision, CAS, locked epoch or nested write failure.
- `src/product/mcp-oauth-atomic-epoch-code-proposal.ts` computes the PKCE S256 challenge from the submitted verifier, looks up code identity on the server, uses a trusted OAuth resource, generates random access/refresh secrets and returns them **only when a single database write is acknowledged**. Unknown committed remote results are never retried: the owner must begin a new authorization flow, since the raw new token secrets are unrecoverable.
- The `redirectUri` argument MUST already pass the real OAuth service's independent URL canonicalization and registered redirect-client checks. Exact SQL equality is not a substitute for production redirect normalization, login state/nonce, first-party identity or origin protections.

## Verified local tests

`test/mcp-oauth-atomic-epoch-code-staging.test.ts` has **9/9 PASS** on Windows Node SQLite covering:
- one PKCE-protected code exchanges to usable access and optional refresh;
- MCP-only scopes do not issue refresh;
- replay and 16 simultaneous same-code exchanges admit **one**;
- wrong PKCE verifier, client, redirect or resource never consume code;
- expired or logged-out epoch denies redemption;
- synthetic access-hash collision rolls back code consumption and refresh issuance;
- uninitialized or locked generation fails closed;
- provider committed-but-lost acknowledgment never returns usable secrets or causes hidden retry.

Local SQLite tests and injected dependencies are **not** real Cloudflare D1 tests. Separate Worker requests, read consistency, provider costs and unknown-state recovery remain unverified.

## Production acceptance blockers

1. Authoritative fresh first-party login and deployed `McpOAuthService` code issuance and token exchange must be versioned by the same session epoch and token-family lineage; this code is **unwired**.
2. Test actual D1 multi-Worker simultaneous code redemption and its rollback semantics in an isolated disposable D1 staging database. Verify JSON1/SQLite trigger semantics and fees with Cloudflare query metrics, not assumptions.
3. Reconcile authorization-code receipt/response loss, client retry UX, OAuth state/nonce/PKCE/verifier and redirect normalization, origin security and token secrecy. Do not store raw bearer or refresh tokens in database.
4. Add owner/device authorization gates and in-flight tool execution revalidation, per-family revocation and safe rollback procedures.
5. Do not copy this fixture into `cloudflare/migrations` or deploy it to `nexowire-control-plane` until production migration review.

**NO-GO for production.** The Cloudflare connection exposed to this assistant has no D1-capable authenticated session. Creating a live remote database, executing D1 SQL or changing site configuration was not attempted without a safe authenticated staging target.
