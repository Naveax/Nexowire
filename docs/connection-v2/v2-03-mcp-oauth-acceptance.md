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
