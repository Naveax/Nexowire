# OAuth #07: issuer key-epoch fence, browser-cancel and owner logout gate

**Parent:** #697 exact HEAD `5daa0da17d2d8db93394cd512d2bf80ab2376934` (6/7 CI PASS, Windows Job fast-exit stdout drain failed in `browser-live`, unrelated to OAuth assertion). Parent #675 CAS implementation remains DRAFT.

## Actual isolated source changes

- `D1IssuerFencedGitHubOAuthStateStore` is a source-only, fail-closed adapter for the existing GitHub-login state interface. It requires explicit monotonic configured issuer signing epoch plus secret-derived HMAC key proof. Any request from a newer signer performs an atomic SQLite/D1 UPSERT that advances the stored signer epoch; every subsequent issue and consume uses an SQL statement that checks this epoch and key proof **in the same mutation**. Existing pending states from previous epochs become logically non-consumable even if an old Worker continues using an old key. Old signer requests cannot lower the persisted epoch; a mismatched key at the same epoch is denied. Revocation of old pending states remains possible.
- `revokeGitHubOAuthBrowserState` requires the original GitHub signed state, exact HTTPS origin, unexpired timestamp and the same `__Host-nwx_github_oauth` browser secret, then CAS-revokes pending state. Wrong browser and replay fail. The server cannot detect mere tab closure. If no explicit cancellation occurs, the strict ten-minute expiry still denies old callbacks. **Cloudflare cancellation route is not wired**.
- `FirstPartyMcpOAuthLogoutBoundary` is an explicit strict session-wide revocation bridge. It requires an injected **independently authenticated first-party owner session verifier**, exact owner match and a separately provided durable `ProposedMcpOAuthSessionEpoch` authority. It rejects MCP access/refresh Bearer values, service identity and foreign owners. Only an epoch-integrated issuer, access verifier and refresh rotator can actually enforce global logout. **Access-only `invalidateAccessToken` retains its existing semantics and does not automatically revoke refresh.** Unconfigured/unknown first-party owner identity fails closed. A real source-level handler connecting all parts is NOT deployed.

## Reviewed migrations (not installed or applied)

```sql
CREATE TABLE github_oauth_issuer_signers (
  issuer TEXT PRIMARY KEY NOT NULL,
  signing_epoch INTEGER NOT NULL CHECK(signing_epoch > 0),
  key_proof TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
```

The existing unprovisioned `github_oauth_browser_states` table from #675 must be present in the same independently authoritative D1 database. The epoch is configured **server-side**, not derived from request/state/Bearer. The externally approved and rollback-fenced monotonic version is essential: a newly initialized empty DB could otherwise admit a stale signer first. The first recognized new-key request logically revokes old state, but real issuer rotation control-plane integration must prevent old signing secrets from being re-enabled as a higher epoch. Physical D1 multi-region CAS authority and rollback protection remain **NO-GO**.

## Negative source tests

`test/github-oauth-issuer-fence-and-abandon-negative.test.ts` exercises dual file-backed SQLite connections, old vs rotated issuer key, old worker rollback, same-epoch forged signer, signed browser cancellation vs foreign cookie, exact 10-minute abandoned tab expiry, missing D1 tables/fail-closed provider.

`test/oauth-first-party-owner-session-logout-gate.test.ts` rejects foreign owners, spoofed service sessions and bare MCP access/refresh tokens as a full-logout authority. Existing `mcp-oauth-atomic-epoch-refresh-staging` and `mcp-oauth-account-logout-staging` tests are **staging fixtures**, not physical deployed verification. The new gate test is an independent authorization-boundary fixture, not actual D1 full logout acceptance.

## Strict release constraints

No live OAuth credentials, Cloudflare D1, migrations, DNS, Broker, Windows high-token CORE/ROOT, UAC or VM changed. All mutations here are **repository source and CI**. Do **not** merge to main or deploy until the parent #675/#697 integration, independently approved D1 state/epoch migrations, staging signer rotation, authoritative session logout/refresh transaction and real ChatGPT/Codex login checks have passed. A signed OAuth browser grant is never a Windows elevated CORE capability.
