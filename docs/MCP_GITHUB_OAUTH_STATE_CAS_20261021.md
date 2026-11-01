# #07 GitHub OAuth login CSRF: browser-bound atomic state (2026-10-21)

## Exact scope

This is an **isolated source-only DRAFT** security implementation based on `Naveax/Nexowire` `main` at `754cc4364822be5fda528f54042fb22a84f19924`. No production Cloudflare Worker file, D1 database, migration, DNS, OAuth credential, live login, Agent, Broker, Windows UAC or VM is changed. Do not deploy or merge without the gated wiring below.

This protects **GitHub login for the Control Plane account**, which precedes ChatGPT/Codex MCP OAuth authorization. It does not modify ChatGPT/Codex OAuth PKCE, resource scopes, access/refresh token issuance, CORE or ROOT Windows elevation.

## Security contract

- `GET /auth/github/start` requires an injected **shared durable** `GitHubOAuthStateConsumeStore`; **fail closed** if absent/unavailable. Creates a random 256-bit nonce and an unrelated 256-bit browser secret, keeps the secret only in a `__Host-nwx_github_oauth` `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` cookie. Generates purpose-separated HMAC-SHA256 **v2** signed state with exact HTTPS origin, 10-minute expiry, safe local redirect path and HMAC browser-binding proof. The raw cookie secret is **not** in the state.
- Before any GitHub redirect, a shared CAS store records the **hash of the state** as `pending` with an absolute expiry. It never stores plaintext OAuth code, session cookie, state, refresh token or client secret. If issuance fails there is **no redirect**. Memory store is tests only.
- Callback verifies exact origin, MAC, signed nonce/purpose/expiry, presence of **exactly one** valid `__Host-` cookie, and constant-time browser-secret binding *before* attempting an atomic `pending → consumed` database update. Only a single successful consume is allowed to perform GitHub code exchange. A retry after network error remains **rejected**, not silently replayed. On successful login the browser cookie is cleared, and a separate ordinary signed account-session cookie is issued.
- Trusted cancellation/revoke of a pending state uses `pending → revoked` CAS; neither a revoked nor consumed state can become pending or exchange a code. Revocation is **not** revocation of already issued OAuth access/refresh credentials or CORE/ROOT.
- Old stateless v1 state is rejected by this GitHub login flow. The original `issueOAuthState/verifyOAuthState` functions remain for the distinct **GitHub App setup manifest** flow, which needs a separate reviewed one-time binding before its setup credentials can be accepted as fully hardened.
- D1 provider/storage failure returns `OAUTH_STATE_STORE_UNAVAILABLE` / 503 before any GitHub exchange. No silent fallback to legacy signature-only verification. App code never trusts a control-plane Bearer token as a signed Windows privileged Broker/CORE or UAC approval.

## D1 migration and wiring **not applied**

Production requires a **separately reviewed create-only** D1 migration, then safe staged Worker wiring passing `new D1GitHubOAuthStateConsumeStore(env.DB)` as `config.stateConsumeStore` to GitHub login start **and** callback. This PR intentionally does not modify `cloudflare/worker.js` or live database schemas. Migration proposal:

```sql
CREATE TABLE github_oauth_browser_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','consumed','revoked')),
  changed_at INTEGER NOT NULL
);
CREATE INDEX idx_github_oauth_browser_states_expiry
  ON github_oauth_browser_states(expires_at);
```

D1 `INSERT ... ON CONFLICT DO NOTHING` and `UPDATE ... WHERE status='pending' AND expires_at>now` must expose trustworthy `meta.changes=0|1`; missing/ambiguous metadata is an outage, never authenticated success. Use a conservative audited cleanup of **expired** rows only, maintaining enough replay tombstone lifetime and checking that expiry validation always rejects stale HMAC state. Production rollout must be atomic/guarded: deploying the source without supplying the store deliberately makes GitHub login unavailable (fail-closed). Do **not** merge to main or deploy until migration, Worker wiring, staging replay and rollback gates are accepted.

## Adversarial source tests and physical gaps

`test/github-oauth-browser-state-negative.test.ts` covers forged signed role/state, wrong HMAC key, wrong origin, cross-browser/missing/duplicate cookie, 10-minute expiry, concurrent 20-way repeated callback consumption, explicit revocation, 2-connection file-backed SQLite/D1-style CAS race, storage failures, old v1 state rejection and denial before GitHub token exchange. `test/github-oauth.test.ts` exercises new browser cookie and real function call sequence using synthetic GitHub API replies. All fixture tokens, secrets and GitHub identities are invented.

**NOT acceptance:** Cloudflare D1 durability under actual multi-region concurrency, GitHub production login, browser cookie behavior behind real reverse proxies, renewal across OAuth callback hops, logout and all pending-state revocation, real ChatGPT/Codex logged-in MCP tool calls, refresh-token revocation or any Windows CORE/ROOT token/elevated Broker. Distinct signed owner approval and protected Windows Broker still gate any privileged execution. Real staging credentials/endpoint and explicit rollout ownership required.
