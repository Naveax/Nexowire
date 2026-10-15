# Scale v2 S1: OAuth session generations and safe re-login proposal

**2026-10-15 | S1 #483 | STAGING-ONLY.** This proposal is stacked on draft PR #502's one-shot hard logout fixture. It does **not** modify production OAuth routes, deployed Cloudflare migrations, live tokens, Agents, quota or billing. No production rollout is authorized.

## Existing limitation and the new model

The original OAuth D1 schema has account-scoped access, refresh and authorization-code records, without a session family or generation. PR #502 proves only a hard account lock that can revoke existing tokens, but blocks **all** later logins. This slice tests the next step: a monotonic per-account `generation` with `locked` state so a fresh first-party login can create a new authorization epoch without reactivating historical credentials.

`test/fixtures/scale-v2-s1-oauth-session-epoch-staging.sql` is deliberately separate from `cloudflare/migrations`. Loaded after the PR #502 test-only hard-lock fixture, it:

1. Adds `session_epoch` columns to existing OAuth access, refresh and authorization-code tables (**SQLite staging only**, with legacy rows defaulted to epoch 0).
2. Backfills previously hard-locked accounts as `generation=1, locked=1`, preserving the revocation state. Accounts without any logout retain implicit generation 0.
3. Replaces only the earlier **staging** hard-lock issuance triggers with checks requiring an unlocked current generation for new token/code inserts.
4. Records `logout` and `reauth` events by globally unique operation ID. A SQLite nested trigger performs a compare-and-swap generation transition in the **same top-level INSERT**. Logout advances generation and locks the account, revoking every existing account token/code; a separately authenticated re-login advances generation again and unlocks issuance for **only that new generation**.
5. Rejects stale-epoch/locked-account insertion, conflicting transition generations and reused operation IDs. A failed insert and its trigger updates roll back together.

`src/product/mcp-oauth-session-epoch-proposal.ts` demonstrates the authoritative sequencing. It never consumes caller-provided quota/device privileges, and cannot be called by any currently deployed Worker. Account identity is supplied from a trusted session, and each transition requires injected **fresh first-party owner verification** for logout or **independent fresh-login verification** for reauth. The latter must NOT accept an old access token as proof of a fresh login. Unknown database states fail closed; a duplicate transition is **not** permission to execute an MCP tool.

## Local verification

`test/mcp-oauth-session-epoch-staging.test.ts` covers:
- Account isolation and expiration of both access/refresh/code on logout.
- Fresh re-login at a higher generation and refusal of every old generation.
- Repeated logout/login cycles without reviving previous tokens.
- Fresh re-login proof required and cross-account attempts denied.
- Same-ID concurrent transition admitted once; competing new IDs cannot unlock the same generation twice.
- PR #502 permanent-lock rows correctly backfilled to locked generation 1, with independent reauth required.
- Globally unique operation-ID namespace and legacy token writer fail-closed.
- Historical refresh token never rotates after new login, stale refresh/code SQL writes rejected.
- Unknown D1 failure and invalid IDs rejected.

**DEV evidence:** 13/13 new tests; 33/33 combined S1 OAuth tests on Windows; `npm run typecheck` and `npm run build` PASS. The tests use synchronous local SQLite, fake first-party verification callbacks and the actual old OAuth service for legacy validation; they do **not** prove independent Cloudflare Workers or live identity-provider authentication.

## Blocking acceptance before production

- **Most important:** `McpOAuthService.issueTokens`, D1 token writers, OAuth refresh rotation, authorization code issuance, access-token verification and live Worker routes are **not epoch-aware**. Current legacy token writes default to session epoch 0 and therefore correctly fail closed after the first logout. A true release requires an atomic, server-verified epoch-scoped issuance/rotation protocol. In particular, refresh consumption and replacement issuance must not strand a legitimate session on a later insertion failure.
- The injected `verifyFreshFirstPartyLogin` is **not** a deployed identity-provider flow. Its binding to current OAuth issuer/resource, account, state/nonce, browser session, cookies, tokens and account ownership requires independent review and real tests.
- Global logout invalidates existing credentials but **does not cancel already-running tools**. In-flight mutating operations require separate current owner/device/permission gate checks and a safe tool execution boundary.
- Define per-device/per-client token **family** invalidation, session logout semantics, account merges/transfers, generation overflow policy, retention, historical noncanonical tokens and data-backfill safety.
- Prove actual D1 transactional trigger behavior under separate Workers, latency, billed reads/writes, rollback and cost hard-stop under owner-approved staging. Do not extrapolate from SQLite.
- No change in live Agent v1.0.5 services, production quota, Cloudflare schema, paid access or deployment flags.

**GO/NO-GO:** This prototype improves the DEV design beyond permanent hard-lock but is **not user-ready OAuth**, and it must not be wired to a production issuer before all blocking gates are closed.
