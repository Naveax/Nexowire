# Scale v2 S1 | One-call fused MCP Hub client preflight

> DEV-only candidate, **not wired into the running Hub or deployed**. [S1 issue #483](https://github.com/Naveax/Nexowire/issues/483), [master #482](https://github.com/Naveax/Nexowire/issues/482). Server-side gated implementation [PR #492](https://github.com/Naveax/Nexowire/pull/492), merged as `51e386a7c08142ab2af472fbf860a100e923ef17` with exact-head 7/7 CI. The Worker route remains hardcoded OFF.

## Why this exists

The existing authenticated hosted MCP tool request authenticates current OAuth state via one Worker HTTP POST and charges the quota in another Worker POST. The future fused endpoint can combine both checks **on the server** if the caller sends a single bounded invocation identifier. A client needs strict response parsing and deterministic replay behavior before any flag/canary switches are attempted.

## Isolated first-party client

`src/hub/fused-mcp-authorize-charge-client.ts` exports `FusedMcpAuthorizeChargeClient`. It can be **explicitly constructed by a DEV-only harness** using the existing trusted control-plane HTTPS URL and service token. It is not imported by the current Hub entrypoint or existing `ControlPlaneMcpClient`; there is **no automatic opt-in or fallback**.

- Makes exactly **one** `POST /api/v1/internal/mcp/authorize-charge` with the OAuth bearer token, explicit validated stable invocation ID, bounded tool name and optional boolean special-skill flag. No user/plan/quota-subject/role fields may be caller-provided.
- Requires an explicit, correctly shaped `authenticated: true` response and a `charged` decision. Validates the returned account role, per-device SAFE/FULL modes, allowed devices, owner device/folder IDs and names, and bounded numeric charge/remaining credits. Malformed or overbroad projections **never authorize a tool**.
- Returns bounded rejection results for 400/401/403/409/429. Duplicate 409 is not retried, nor is an expired/revoked token, feature denial, or exhausted quota.
- Fails closed with `MCP_AUTH_CHARGE_UNAVAILABLE` on network or timeout, HTTP 5xx, bad JSON, missing fields or malformed ownership; **never falls back** to the old 2-request path because the first reservation may already have been committed.
- Does not persist, log, emit, or reflect a raw access token, service token or private device payload in the decision.
- Self-hosted/local MCP auth continues to use its existing path. The candidate does not adjust session privileges, reconnect semantics, usage ledger or Cloudflare deployment flags.

## DEV evidence

```sh
npm run typecheck
npm run build
node --test --import tsx test/fused-mcp-authorize-charge-client.test.ts test/control-plane-mcp-auth.test.ts test/hosted-metering.test.ts
npm run ai-screen:launch-audit
```

In addition to fake-fetch protocol tests, `test/fused-mcp-client-server-contract.test.ts` now permanently composes the first-party client and server handler in memory, covering one accepted request/one reservation, 12 concurrent repeated invocation IDs (1 charged and 11 rejected), token revocation, role denial and Free exhaustion. Fake fetch tests verify precisely **one Worker HTTP fetch** on authorized and rejected decisions, stable request structure, service bearer, safe account/device projection, malformed success refusal, rejection codes, network/5xx failures, invalid IDs rejected before network, and insecure endpoint rejection. These tests **do not** prove production Cloudflare cost, distributed quota safety, or staged full protocol integration.

## Remaining gates

- [ ] Integrate the client only when the server candidate has a compatible CI-verified version and a new **independently reviewed, default-OFF** Hub feature flag.
- [ ] Validate complete OAuth lifecycle with actual first-party token store, expired/revoked resource, service auth and real D1 under independent concurrent Worker invocations.
- [ ] Resolve ambiguous reservation network failure without duplicate execution. The new client currently **denies**, not retries, until a separate status/resumption protocol is proven.
- [ ] Run a DEV-only end-to-end request with a single opt-in Worker backend and no production device impact.
- [ ] Compare provider-level request/D1-read/write and p95 latency in an authorized low-budget staging canary with instant, tested rollback.
- [ ] Explicitly confirm two preexisting Agent v1.0.5 connections before controlled canary. Do not change #271 privileged-runtime hold.

**This PR is scaffolding; existing production calls still make two Worker fetches.**
