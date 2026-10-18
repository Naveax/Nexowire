# MCP OAuth / Codex CLI compatibility (source-only, 2026-10-18)

## Boundaries

* Worktree: `fix/parallel-07-codex-oauth-compat-20261018`, based on `8bf7ce10972e78268e3cac945e833781b8d6846c`.
* Scope: hosted OAuth metadata/redirect and MCP Hub authorization. **No production Cloudflare, Worker, GitHub OAuth, agent or billing deployment**.
* ChatGPT and Codex CLI are **independent public OAuth clients**. Do not reuse client IDs, authorization codes, tokens, consent, state or refresh tokens across them.
* GitHub issue #484 primarily tracks daily quota and identity, not Codex OAuth itself.

## Runtime contract / known requirements

1. MCP resource must publish protected resource metadata and a 401 Bearer challenge with `resource_metadata` and `scope="mcp"`. Protected-resource `scopes_supported` lists `mcp` only; `offline_access` remains advertised by the authorization server as an optional refresh-token request, not a resource requirement. Server metadata must have the exact canonical issuer, resource, PKCE S256, public DCR and token endpoint.
2. OAuth `resource` is required on authorize, code exchange and refresh, and access-token verification must compare it exactly. Wrong issuer/audience, expired, revoked, wrong client, wrong scope or wrong resource MUST NOT result in native tool execution.
3. Codex CLI 0.142.5 (installed on work-pc at inspection) is known to sometimes register `http://127.0.0.1:<port>/callback/...` but authorize via `http://localhost:<same-port>/callback/...`. The narrow allowance is **only these two explicit loopback names with HTTP, exact port/path/query** during registered redirect URI checking. The code/token exchange remains bound to the actual authorize URI. Other hosts, schemes and callback changes are denied.
4. Unknown/invalid authentication, including malformed or expired OIDC JWT, is `401 MCP_AUTH_REQUIRED` (token layer) with the protected-resource challenge. Issuer/JWKS outages, Control Plane transport/HTTP failures and internal verifier failures produce `503 MCP_AUTH_VERIFIER_UNAVAILABLE` (verification layer, retry later), never incorrectly described as an invalid account token. The Control Plane's explicit HTTP 200 `authenticated:false` is treated as a real token denial; raw provider bodies/errors are not exposed. No raw errors, tokens, client secrets or refresh secrets are logged.
5. Trusted control-plane replies MUST explicitly include an array of scopes containing `mcp`; missing/invalid scopes fail closed before tool dispatch. The hosted Worker already returns the verified token scopes. Mocked historical replies are updated in tests; any older external Worker that lacks this field must be upgraded prior to rollout.
6. Authorization denies for account disabled/session revoked, wrong device/ownership and policy decisions require **trusted current owner-state evidence**. Do not claim those specific reasons based solely on a 401. Stage/proposal epoch and logout flows are not live acceptance.

## Safe diagnostic decision tree

| Symptom | Trusted classification | Next action |
|---|---|---|
| No/invalid bearer, expired token, unknown token | token (`MCP_AUTH_REQUIRED`) | `codex mcp login <name>` for configured Codex servers, or reauthorize ChatGPT connection |
| MCP verifier/network error | verification (`MCP_AUTH_VERIFIER_UNAVAILABLE`) | inspect issuer and service reachability; retry, don't replace credentials blindly |
| OAuth `invalid_request` on callback | client/redirect | verify DCR URI and exact port/path, HTTPS/loopback only |
| OAuth `invalid_grant` | code/refresh | new authorization; don't replay an authorization code or rotated refresh token |
| HTTP 403 forbidden tool | policy/scope | check granted scopes and the tool authorization policy |
| Authenticated but device not listed | device/owner | confirm owner and current device assignment via trusted control-plane state, not token contents |
| Logout / owner transfer | session/owner | require fresh server-side session/epoch/revocation evidence, not just cookie clearing |

## Verification and limits

* Run `node --test --import tsx test/mcp-oauth-client-compat.test.ts test/mcp-oauth.test.ts test/control-plane-mcp-auth.test.ts test/oidc.test.ts` from the worktree.
* Run `npm run typecheck` and `npm run build`.
* Staging account/device/owner epoch tests are separate from these protocol tests and do **not** mean production revocation is complete.
* An isolated, **real Codex CLI 0.142.5** executable login to a temporary localhost synthetic OAuth issuer passed using `test/fixtures/codex-cli-oauth-loopback-smoke.ts` (fresh sandboxed `CODEX_HOME`; discovery, DCR, PKCE S256, state/resource, callback and code exchange; no secrets printed). This is **not** a real Nexowire production/staging account or real ChatGPT OAuth connection. The real ChatGPT connector cannot be re-authenticated by this test harness. Live OAuth acceptance, issuer configuration, public HTTPS accessibility, physical-device owner transfer and refresh session revocation remain release gates.
* Never print `Authorization`, `access_token`, `refresh_token`, cookies, OAuth codes, stored secrets or service tokens in logs or PR output.

## Independent client acceptance, exact limitations

| Evidence | Status | Verified boundary |
|---|---|---|
| Real Codex CLI 0.142.5 `mcp add` / `mcp login` with fresh `CODEX_HOME` | PASS, isolated | Ephemeral localhost synthetic AS; discovery, DCR, PKCE S256, resource, state, callback, code redemption; observed unauthenticated 401 |
| Native MCP tool invocation **from Codex** after login | NOT PROVEN | The CLI-only login smoke did not launch a model/tool session; the fixture recorded `authenticatedMcp=0` |
| Real ChatGPT MCP OAuth browser/account linking | NOT PROVEN | Existing ChatGPT-shaped simulated client test is not the actual ChatGPT OAuth runtime |
| Separate ChatGPT and Codex OAuth registrations | PASS, in-memory negative tests | Distinct client IDs; wrong-client authorization code and refresh-token use rejected |
| Expiry, PKCE mismatch, audience, scope, replay | PASS, synthetic | Tested through real service/store and isolated authorization, not deployed account |
| Logout / revoked owner session / ownership change | PASS, staging/epoch proposal tests | No production issuer-epoch or refresh/session revocation deployment proof |
| 401 invalid token vs 503 verifier/HTTP/network/malformed JSON | PASS, targeted | No raw upstream exception or token in response |
| Actual customer-hosted trusted staging issuer/account | BLOCKED | No authorized staging credentials or endpoint were available for this run |

To reproduce the Codex-only bounded smoke from the clean worktree on a Windows host with Codex installed:

```powershell
node --import tsx test/fixtures/codex-cli-oauth-loopback-smoke.ts
```

The fixture creates a separate temporary `CODEX_HOME`, a local-only OAuth server and a generated test account. The native Windows x64 `codex.exe` is launched directly, not through `cmd.exe`, to avoid detached wrapper descendants. Captured CLI stdout/stderr stays in memory, is bounded to 64 KiB, and is never printed or written; output includes only booleans/counters, never authorization URLs, codes, access/refresh tokens or local state. The callback is accepted only when its local host, **exact port, path and state** match the client-requested redirect. Cleanup is attempted on exit; **Windows can still open a local browser despite the `BROWSER` shim**, and a locked temporary browser cache may prevent full removal. Run this fixture manually only, never unattended in CI. It does not authorize or mutate production Nexowire OAuth accounts/devices; a passing loopback test is NOT production acceptance. If cleanup fails, verify the precise fixture-owned processes and temporary directory before removing anything; never close an unrelated browser.
