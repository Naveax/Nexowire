# Nexowire #07 — OAuth, HTTP parser and DOS acceptance (2026-10-20)

**Review scope:** current main at inspection: `fda2a2da164ea7c6a2fe2271fc669f1fd623cede`. Parent **DRAFT PR #598**: `fd7ae72724d39c711589335fc72c1bda3d94621c`, issue #588. This child PR adds independent negative tests and a minimal trusted Control Plane reply-contract correction. It must be reviewed and integrated into #598 **before** #598 is merged into main; do not merge the child directly to main or deploy to production.

## Evidence, not assumptions

| Area | Evidence | Acceptance |
|---|---|---|
| Current ChatGPT connector | Nexowire MCP surface v1, agent protocol v2; native-agent tool surface reachable on Work PC and Naveax, Agent 1.0.5 | Connector availability is **not** ChatGPT OAuth sign-in proof |
| ChatGPT OAuth | Distinct registered public client, PKCE S256, resource and scope tested in synthetic service/store tests | **BLOCKED**: no actual connector OAuth authorization with a trusted staging account |
| Codex CLI OAuth | Real Codex 0.142.5 previously completed isolated loopback login; separate client-id/code/refresh token tests | **BLOCKED**: no credentialed authorized staging issuer/account, real post-login native tool call, or real refresh/logout |
| Issuer/discovery | Earlier **read-only** production GET discovery verified HTTPS issuer/resource metadata, advertised PKCE S256, registration and refresh grants | Metadata presence does **not** prove live token exchange or revocation |
| Owner/device scope | Actual ControlPlaneMcpClient filters ownerDevices against allowedDeviceIds, rejects missing/incorrect `mcp` scope; role-based admin tool denial in isolated harness | **Synthetic**; no physical owner transfer/revoke or privileged native dispatch |
| Access expiry, refresh rotation, logout | Existing in-memory/SQLite/proposed account-epoch regression tests | **Synthetic only**; no authorized live staging refresh/revoke |
| Control Plane HTTP 5xx, network and invalid JSON | Safe 503 without token body leakage, isolated control-plane client and HTTP tests | Source PASS, hosted external failure-injection not tested |
| Control Plane 200 non-object JSON or invalid `authenticated` type | Isolated negative initially exposed false 401; new correction maps to 503. Explicit `authenticated:false` continues to be 401. | Source regression PASS |
| PR #598 9.5 MiB parser cap | Actual `createNexowireMcpExpressApp` bound to 127.0.0.1; 221 KiB unauthorized JSON reaches 401; over-cap JSON gets 413; hostile Host gets 403; malformed JSON gets 400 | Isolated HTTP PASS, **not** production deployment |
| Parser-stage DOS | Four incomplete **unauthenticated** chunked JSON uploads reserve all large-body parser slots; fifth large request gets `503 MCP_JSON_PARSER_BUSY`, but small requests reach 401 | **Known residual release concern**: pre-auth large-request starvation remains possible |

## Trust boundaries

The real `src/mcp/http.ts` creates the Express app with the finite parser before mounting OAuth authorization middleware. The child test harness preserves that middleware **ordering** and calls the real parser, `ControlPlaneMcpClient`, `resolveMcpAuthorization`, `classifyMcpAuthFailure`, and `deniedMcpToolNames`. It substitutes synthetic Control Plane replies and a no-side-effect terminal route. It does **not** run a fully configured Hub, Cloudflare Worker, native device tool call or a real ChatGPT/Codex OAuth callback. It intentionally does not change parser concurrency policy, production auth endpoints, DNS, Cloudflare or credentials.

A request rejected as `MCP_JSON_PARSER_BUSY` is a **parser capacity** 503, distinct from `MCP_AUTH_VERIFIER_UNAVAILABLE` (trusted verifier outage) and 401 `MCP_AUTH_REQUIRED` (explicit token denial). A 9.5 MiB inbound JSON envelope is not a 9.5 MiB decoded file payload, not a limitless MCP message, and is not proof of any ChatGPT platform transfer limit.

**Remaining physical acceptance gates:** independently provisioned authorized HTTPS staging issuer and two client registrations; real ChatGPT connection OAuth round-trip; real Codex CLI login plus post-login native tool completion; expiry/refresh/logout/revoked owner/device grants against current deployed ownership state; staged 9.5 MiB parser load and memory/backpressure with bounded concurrent clients; signed and audited release and rollback. No production acceptance is claimed.

**Secret-handling:** fixture tokens are synthetic; responses and CI logs show only statuses/error codes and contain no access/refresh tokens, authorization codes, service tokens, live user IDs or upstream diagnostic bodies. No real session, credential, production OAuth setting, real DNS or Agent service was mutated.


## 2026-10-21 parent integration

This child evidence and `test/mcp-oauth-http-parser-isolation.test.ts` were incorporated into parent PR #598 after the #600 gzip inflated-body admission fix. Parent source-only admission and verifier negative CI are evaluated on the latest exact GitHub head; no live OAuth login, Cloudflare configuration or Agent release is implied.
