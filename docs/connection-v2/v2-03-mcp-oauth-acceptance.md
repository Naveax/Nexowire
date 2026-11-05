# Connection v2 V2-03: disposable MCP/OAuth staging acceptance (V2-08 handoff)

## Scope and evidence provenance

This is a **read-only**, explicitly authorized staging validation. It does not create a
Cloudflare tunnel, DNS entry, owner, token, device enrollment, production process or
ChatGPT connection. Never run against NAVEAX, Work-PC or production DNS/accounts.
A test that only proves the 401/metadata boundary is **not** a successful OAuth
consent, authenticated MCP initialize, or completed read-only tool.

Use an independent disposable HTTPS MCP origin and authorization issuer under
V2-08's control with a temporary scoped access token for that exact resource.
Only run where the operator explicitly controls the staging infrastructure.
No credential values, response payloads, cookie or account IDs belong in CI logs.

## CLI evidence (HTTPS staging only)

Set these variables in a secured disposable shell. Use a non-secret, exact marker
the real read-only \`nexowire_surface_info\` tool must produce, for example a
known staging \`mcpSurfaceVersion\`. Never put a secret value in the marker.

\`\`\`powershell
$env:NEXOWIRE_V2_STAGING_ACK = 'disposable-only'
$env:NEXOWIRE_V2_STAGING_RESOURCE = 'https://REPLACE-STAGING-ORIGIN/mcp'
$env:NEXOWIRE_V2_STAGING_ISSUER = 'https://REPLACE-STAGING-ISSUER'
$env:NEXOWIRE_V2_STAGING_BEARER = '<ephemeral-staging-only-access-token>'
$env:NEXOWIRE_V2_STAGING_EXPECTED = '<non-secret-expected-tool-result-marker>'
node --import tsx scripts/verify-connection-v2-03-staging.ts
$exitCode = $LASTEXITCODE
Remove-Item Env:NEXOWIRE_V2_STAGING_BEARER
if ($exitCode -ne 0) { throw "Staging acceptance failed with exit code $exitCode" }
\`\`\`

The probe enforces exact HTTPS \`/mcp\`, no URL credentials/query/fragment,
a single exact expected protected-resource authorization issuer, an anonymous
Bearer challenge, authorized JSON-RPC initialize (protocol 2025-03-26),
\`tools/list\` presence, and the completed \`nexowire_surface_info\`
\`tools/call\` with matching expected text and \`isError !== true\`.
JSON and finite SSE responses are supported. \`mcp-session-id\` is propagated
and must remain stable. Each step uses \`redirect: 'error'\`, a total deadline
and bounded output. No automatic retry and no mutation operations.

Exit 0 means **staging bearer -> read-only tool completion** only. Exit 1
means the acceptance condition failed. Exit 2 means malformed/unapproved setup.
No status in this script claims a ChatGPT session, browser OAuth authorization
code flow, real device enrollment, reboot or end-to-end Cloudflare validation.

## V2-08 real ChatGPT OAuth acceptance, separately witnessed

1. Start from the approved, disposable integrated exact SHA and record the
   candidate PR/commit SHA, DNS/issuer/resource matching and active CI run/job ID.
   Never use an owner production credential. Check token audience, issuer, owner,
   device restriction and quota separately at the real control-plane boundary.
2. From an **off-network** ChatGPT connector test identity, complete the real
   browser authorization code + PKCE grant (human-owned consent), enforce exact
   resource/audience and issuer. Record outcome as PASS only with provider-side
   and Hub-side redacted correlation/receipt evidence.
3. Observe the authenticated MCP \`initialize\` then \`tools/list\`, then
   a narrowly authorized read-only \`nexowire_surface_info\` (or approved
   single-device \`machine_health\`) call. Capture request IDs, exact output
   assertions, HTTP status, session continuity and completion signal, **not
   bearer tokens, full tool data or provider secrets**.
4. Observe Agent WSS HTTP 101 only after device-bound authorization and
   correct hello identity. Test revoked, expired, wrong-device and wrong-owner
   cases (zero unauthorized mutation dispatch). On a mutation with lost ACK,
   UNKNOWN must remain UNKNOWN and must **not** replay automatically.
5. Test public default deny (\`/health\`, \`/admin\`, \`/agent\` without opt-in,
   query, spoofed Host/Origin, CONNECT), metadata/issuer mismatch, timeout,
   upstream disconnect/half-open and cleanup. Verify upstream streams cancel.
6. Independently test Windows scheduled-task process tree stop, real PC reboot,
   off-network two-device acceptance, rollback, DNS rebinding/public admission,
   Cloudflare binary custody and provider traffic/quota enforcement.
7. Store exact SHA, attempt, job IDs, exit codes, sanitized test receipts,
   owner sign-off and literal NOT_RUN for any unexecuted gate in the
   V2-08 release evidence. Do not merge or deploy on partial success.

## Readiness transitions

| Prior | Observation | Next |
| --- | --- | --- |
| UNAVAILABLE | Trusted local process is running, no external proof | LOCAL_PROCESS_RUNNING |
| LOCAL_PROCESS_RUNNING | Exact metadata + issuer + anonymous OAuth challenge | PUBLIC_OAUTH_BOUNDARY_OK |
| PUBLIC_OAUTH_BOUNDARY_OK | OAuth bearer initialize + list + completed expected read-only tool | AUTHENTICATED_MCP_READY |
| PUBLIC_OAUTH_BOUNDARY_OK | Device-bound Hub authorization and hello accepted | AGENT_AUTHENTICATED |
| Any live stage | Hub/Agent disconnect, timeout, invalid authorization or wrong issuer | DEGRADED |
| Any stage | Local process stops / unreachable | UNAVAILABLE |
| DEGRADED | Fresh complete proof (not cached 200/401) | respective verified stage |

For simultaneous MCP+Agent healthy states the current single-state priority
chooses AGENT_AUTHENTICATED; this is not proof of MCP tool completion.
Inspect independent evidence booleans if both are required for release.
The standalone script does not maintain a process lifecycle monitor.

## Mandatory NOT_RUN until witnessed

- Genuine off-network ChatGPT OAuth connect and PKCE: NOT_RUN.
- Internet-origin MCP tool call, WSS authorization, real TLS/DNS: NOT_RUN.
- Real two-PC migration/reboot and 24-hour soak: NOT_RUN.
- Release integration and production-ready: NO-GO until V2-08 complete.


## Readiness monitor implementation notes

\`ConnectionV2ReadinessMonitor\` is a non-authoritative ephemeral status
machine, not a token validator. \`observeLocalProcess\` must only consume local
supervisor observations. \`inspectPublicBoundary\` invokes the real public
doctor; \`proveAuthenticatedMcp\` invokes the bounded MCP read-only protocol
probe, not a boolean provided by remote HTTP input. \`observeHubAgentAdmission\`
may be called only by trusted Hub authorization code after device-bound
credential verification, never by an untrusted Agent/client. The actual
V2-02/V2-07 mutation dispatch authority and revocation epoch remain
independent mandatory enforcement points.

Default proof age is 60 seconds; caller must refresh local process evidence
and independent proof before TTL. Stale proof, wrong device identity, revoked
grant, transport outage or lost Hub triggers DEGRADED. A local stop triggers
UNAVAILABLE. The monitor never auto-retries unknown mutations, persistently
grants access, or claims real ChatGPT OAuth consent.


## Round 4: mandatory remote mutation authorization (owner handoff)

**Remote-only availability is blocked until cross-owner integration.**
V2-03 has introduced a fail-closed startup and public-ingress preflight
guard for remote-only Agent traffic. Existing purely local Agent/MCP
behavior is deliberately unchanged. Current #1003 AgentBroker lacks
strict mode; this is a documented NO-GO rather than an implicit bypass.

**Public Hub startup contract:** a trusted actual Broker instance must expose
\`isMandatoryMutationReauthorizationEnabled(): boolean\` and return \`true\`.
The method must report the constructor's private flag set by
\`new AgentBroker({requireMutationReauthorization: true})\`; never derive
it from an environment variable, API request or an untrusted runtime
health payload. Missing method, false, exception => refuse to start
remote-only Hub **before TCP listen or WSS HTTP 101**.

**Owner actions (not to be edited by V2-03):**

- V2-07, \`src/core/agent-broker.ts\`: expose the above read-only method.
  Preserve strict \`register(socket,hello,reauthorize)\`: missing
  verifier closes 1008 without registration or mutation. Before each
  mutation, await an authoritative fresh verifier; require same
  connection incarnation/epoch, and reject on false, exception and
  timeout with zero Agent mutation frames. Never replay a mutation on
  reconnect, lost ACK or UNKNOWN.
- Runtime owner, \`src/runtime.ts\`: construct the real Broker with
  \`requireMutationReauthorization: config.remoteAgentAuthOnly === true\`.
  Do not replace the Broker after ProviderRegistry captured its reference.
  Local mode must continue to use the default non-strict behavior.
- V2-07/HUB owner, \`src/hub/agent-websocket.ts\`: every remotely
  authorized socket must capture \`{ownerId,deviceId,authorizationEpoch,
  leaseExpiresAtMs}\` from authoritative control-plane verification.
  Bind a per-socket \`() => Promise<boolean>\` that re-verifies the
  **same owner and device**, exact live authority generation and
  grant expiry **at mutation dispatch**, and pass it into
  \`broker.register(socket,hello,reauthorizeMutation)\`.
  Refuse unknown/missing owner identity and wrong-device hello. Ensure
  periodic socket checks cannot substitute for per-mutation checks.
  A declined/throwing/slow checker terminates or rejects, never
  permits local static-token fallback in remote-only mode.
- V2-02, \`src/hub/control-plane-agent-auth.ts\` / authority:
  upgrade \`RemoteAgentAuthorization\` from the legacy deviceId-only
  response to ownerId+deviceId+authority epoch+short absolute
  lease expiry. The V2-03 HTTP wrapper refuses deviceId-only results.
  Auth validation must cover revoked owner, expired grant, wrong
  device, wrong issuer, and stale epoch. Return no raw token to health.
  Use TLS and the hardened V2-02 control-plane network rules.
- Authority-owned *atomic revocation contract*: a successful callback
  that races with revocation before \`socket.send()\` is insufficient.
  The authoritative owner/device state must issue a short-lived,
  epoch-bound dispatch lease tied to the exact connection and operation,
  with a linearizable validate-and-admit/fence operation or Agent-side
  authoritative epoch validation before effect execution. The owner
  must specify the lock/transaction ordering and revocation barrier.
  Neither an in-memory TTL nor a second arbitrary GET removes the
  final check/send TOCTOU window. Until implemented, mark this
  race **UNRESOLVED** even if synthetic revoke-before-callback tests pass.

\`verifyLocalFirstPublicUpstream(requireRemoteAgentAdmission:true)\`
must see \`remoteAgentAdmissionContract:'owner-device-epoch-lease-v1'\`
in actual Hub health, not the old periodic
\`device-bound-revalidate-v1\` label. This is **read-only
configuration evidence**, not proof of external owner authentication.

**Exact acceptance matrix:** missing verifier, owner-less credential,
wrong owner/device, token expired, owner revoked, verifier unavailable,
stale epoch and post-101 revocation all require denied mutation,
zero transmitted mutation frames, and no unauthorized Agent side effect.
Evidence must come from *combined exact-SHA* tests, including a real
loopback WebSocket Agent receiver, not just a mocked predicate.
Additional release gates: actual off-network ChatGPT OAuth consent +
MCP initialize -> tools/list -> completed read-only tools/call:
**NOT_RUN until witnessed**. Public Agent startup remains blocked
until all cross-owner code is integrated.

## Round 4 state transition expectations

| From | Event | To |
| --- | --- | --- |
| UNAVAILABLE | Local-only Hub running, no public grant | LOCAL_PROCESS_RUNNING |
| LOCAL_PROCESS_RUNNING | Strict remote authority missing | LOCAL_PROCESS_RUNNING; public Agent startup denied |
| LOCAL_PROCESS_RUNNING | Trusted public OAuth metadata/challenge | PUBLIC_OAUTH_BOUNDARY_OK |
| PUBLIC_OAUTH_BOUNDARY_OK | Authenticated MCP initialize/list/completed expected read-only tool | AUTHENTICATED_MCP_READY |
| PUBLIC_OAUTH_BOUNDARY_OK | Strict Agent owner/device grant verified and WebSocket hello bound | AGENT_AUTHENTICATED |
| AGENT_AUTHENTICATED | Revocation, stale authority epoch, expired lease, missing callback, hub/agent disconnect | DEGRADED; mutation dispatch denied |
| Any state | Local Hub process stops | UNAVAILABLE |
| DEGRADED | Fresh authoritative proof completes again | corresponding verified state |

The status monitor must not be trusted as the dispatch-authority source.
A local session's authorization behavior must not change when remote-only
mode is not enabled. Production/CORE: **NO-GO**.
