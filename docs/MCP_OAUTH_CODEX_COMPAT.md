# MCP OAuth / Codex CLI compatibility (source-only, 2026-10-18)

## Boundaries

* Worktree: `fix/parallel-07-codex-oauth-compat-20261018`, based on `8bf7ce10972e78268e3cac945e833781b8d6846c`.
* Scope: hosted OAuth metadata/redirect and MCP Hub authorization. **No production Cloudflare, Worker, GitHub OAuth, agent or billing deployment**.
* ChatGPT and Codex CLI are **independent public OAuth clients**. Do not reuse client IDs, authorization codes, tokens, consent, state or refresh tokens across them.
* GitHub issue #484 primarily tracks daily quota and identity, not Codex OAuth itself.

## Runtime contract / known requirements

1. MCP resource must publish protected resource metadata and a 401 Bearer challenge with `resource_metadata` and `scope="mcp"`. Server metadata must have the exact canonical issuer, resource, PKCE S256, public DCR and token endpoint.
2. OAuth `resource` is required on authorize, code exchange and refresh, and access-token verification must compare it exactly. Wrong issuer/audience, expired, revoked, wrong client, wrong scope or wrong resource MUST NOT result in native tool execution.
3. Codex CLI 0.142.5 (installed on work-pc at inspection) is known to sometimes register `http://127.0.0.1:<port>/callback/...` but authorize via `http://localhost:<same-port>/callback/...`. The narrow allowance is **only these two explicit loopback names with HTTP, exact port/path/query** during registered redirect URI checking. The code/token exchange remains bound to the actual authorize URI. Other hosts, schemes and callback changes are denied.
4. Unknown/invalid authentication is `401 MCP_AUTH_REQUIRED` (token layer) with the protected-resource challenge. Upstream verifier failure is `503 MCP_AUTH_VERIFIER_UNAVAILABLE` (verification layer, retry later), never incorrectly described as an invalid account token. No raw errors, tokens, client secrets or refresh secrets are logged.
5. Trusted control-plane replies explicitly containing scopes other than `mcp` are rejected before dispatch. Legacy trusted responses without a scopes field remain accepted for backward compatibility with already deployed responses; the hosted Worker currently verifies `mcp` scope before returning identity. Removing this legacy allowance requires a coordinated worker protocol version bump.
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
* `codex mcp list` on work-pc did **not** show a registered Nexowire HTTP OAuth MCP server. Do not claim an actual `codex mcp login` or a real ChatGPT linking round-trip succeeded. Live OAuth acceptance, issuer configuration, public HTTPS accessibility, two independent client registrations, physical-device owner transfer and refresh session revocation remain release gates.
* Never print `Authorization`, `access_token`, `refresh_token`, cookies, OAuth codes, stored secrets or service tokens in logs or PR output.
