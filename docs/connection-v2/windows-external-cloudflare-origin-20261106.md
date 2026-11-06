# Windows Cloudflare external-service origin (candidate, 2026-11-06)

## Purpose

Nexowire's existing self-managed Windows \`cloudflare-run\` is intentionally denied
until its immutable native executable-launch provenance is independently proven.
This new **separate** mode avoids launching cloudflared from Nexowire. The
operator-managed Windows Cloudflare service owns its executable, secret, update,
installation, restart, and tunnel lifecycle. Nexowire owns **only** a loopback
HTTP/WebSocket origin.

This is a usable deployment alternative, **not** a claim that the external
service binary, Windows installer, public OAuth, or real remote Agent is secure
or accepted. It does not automatically install, start, stop, or update the
Cloudflare service and does not bypass the existing self-managed launch denial.

## Local profile

Create an owner-protected JSON file outside the repository, such as
\`C:\ProgramData\Nexowire\cloudflare-external-origin.json\`, with:

\`\`\`json
{
  "version": 1,
  "hostname": "mcp.example.com",
  "listenPort": 43111,
  "publishAgentEndpoint": false
}
\`\`\`

No tunnel ID, tunnel token, binary path, private key or credentials path is
accepted by this Nexowire profile. The real Cloudflare service configuration
must separately and intentionally route this stable hostname to
\`http://127.0.0.1:43111\` and use an HTTP Host header matching the hostname.
Include an explicit fallback of \`http_status:404\` in the service's tunnel
configuration. The service must be installed using the official, reviewed
Windows service process and managed by the local operator.

Required running Nexowire Hub configuration:
- \`NEXOWIRE_HTTP_PORT=43110\` (or another current local port);
- \`NEXOWIRE_MCP_RESOURCE_URL=https://mcp.example.com/mcp\`;
- real \`NEXOWIRE_CONTROL_PLANE_URL\` and protected service token;
- trusted OAuth and authorization/metering configured on the Hub.

After confirming the separate Cloudflare service configuration, run:

\`\`\`powershell
nexowire local-first cloudflare-external-ingress "C:\ProgramData\Nexowire\cloudflare-external-origin.json"
\`\`\`

This opens only the loopback origin. It verifies the local Hub's advertised
public OAuth boundary first. Cloudflared is **not** launched, and Nexowire
cannot claim public readiness merely because the loopback listener started.
Use the existing connection doctor and an externally authenticated read-only
MCP completion to verify real connectivity.

For public Agent \`/agent\` WebSocket relay, change
\`publishAgentEndpoint\` to \`true\` **only** after configuring
\`NEXOWIRE_AGENT_REMOTE_AUTH_ONLY=1\` and its owner/device authority. The
preflight explicitly verifies remote Agent admission readiness. Mutating
operations still require their independent authenticated CAS and native effect
admission; this mode does not make missing authority trusted.

## Safety and roll-out

- The old self-managed \`cloudflare-run\` path remains unchanged/denied on
  Windows until its native launch guarantee exists.
- No Windows service, Scheduled Task, privilege, Cloudflare tunnel, public
  DNS, Hub, Broker, NAVEAX, or Work-PC settings were changed by this source PR.
- Run the origin under a protected service/task account as a separate
  deployment step after an operator-approved trial on a disposable Windows VM.
- Keep the physical CORE owner enrollment and the CAS authorization
  blockers tracked separately. Neither is fixed by this mode.
- Acceptance: Windows CLI/package smoke, strict remote-only /agent negative
  tests, OAuth-bound MCP tool completion via real Cloudflare, reconnect,
  process service lifecycle, and two-device acceptance. Until then, full
  production release remains NO-GO.
