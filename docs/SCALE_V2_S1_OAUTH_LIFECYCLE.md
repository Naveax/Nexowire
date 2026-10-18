# Scale v2 S1: first-party OAuth lifecycle against the fused quota candidate

> DEV-only lifecycle regression. Tracks [#483](https://github.com/Naveax/Nexowire/issues/483), main candidate [#492](https://github.com/Naveax/Nexowire/pull/492). **No Hub runtime or production deployment switch.**

## Tested with the actual first-party OAuth issuer

`test/fused-mcp-real-oauth-lifecycle.test.ts` uses the real `McpOAuthService` and `MemoryMcpOAuthStore` to register a client, authorize an account with PKCE S256, exchange the authorization code, and pass the freshly minted access token to the isolated `createFusedMcpAuthorizeChargeHandler` through a test-only service authentication function. The resulting quota charge goes to the real `ControlPlaneService` using an in-memory control-plane store.

The tests prove:

- A valid first-party OAuth access token with `mcp` scope can be checked and one monthly Free credit reserved; repeat invocation ID returns 409 without a second charge.
- After advancing the deterministic issuer clock beyond the access-token expiry, the fused handler returns 401 **before** attempting a reservation.
- The existing OAuth issuer refuses an authorization request for an unsupported refresh-only `offline_access` scope. A deliberately malformed token store record lacking the `mcp` scope is independently rejected by the fused handler.
- A token issued for resource `https://mcp.example.test/mcp` fails verification against a different configured resource and cannot be charged there.

This supplements the separate real SQLite-backed D1 quota tests in PR #492. It does **not** prove real remote Cloudflare Worker/D1 concurrency, provider costs, a deployed endpoint, availability of active access-token revocation, or a completed S1 production rollout.

## Critical follow-up

The first-party access-token store record includes expiry but presently does not expose an explicit access-token `revokedAt` property or revocation endpoint. **Do not infer immediate access-token revocation from refresh-token rotation.** A future accepted cancellation/revoke flow must define revocation semantics and verify that the Worker checks it before quota reservation. Account/device permission revocation is a separate required gate.

## Commands

```sh
node --test --import tsx test/fused-mcp-real-oauth-lifecycle.test.ts test/mcp-oauth.test.ts test/fused-mcp-authorize-charge.test.ts
npm run typecheck
npm run build
```

The existing Worker route `PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED` remains hardcoded false and existing external MCP 2-request authorization/charge path stays in force.
