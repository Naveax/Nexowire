# Scale v2: Local-first remote MCP ingress (DEV / opt-in)

Date: 2026-10-15. Tracks S1 #483 and S3 #485 under #482. Implementation stage Z1, NOT an active deployment. Independent of draft HyperScale #508. No change to existing Agents, Hub, Cloudflare Workers/D1, payment, quota or services.

## Implemented in this change

- New opt-in command: nexowire local-first ingress --listen-port=43111. This starts a small standalone MCP-facing HTTP ingress at 127.0.0.1:43111 and forwards ONLY POST /mcp and GET /.well-known/oauth-protected-resource[/mcp] to the ALREADY RUNNING localhost Nexowire Hub at 127.0.0.1:43110.
- Reuses existing local Hub's MCP tool list, authenticated device authorization and quota decisions. Does not start or replace a Native Agent or Hub; does not alter a machine service or make a Cloudflare tunnel.
- Rejects /agent (including WebSocket upgrades), /health, admin/debug/filesystem paths, encoded or query variants, GET/DELETE /mcp, missing bearer, hostile Host or Origin, oversized payloads and excess concurrent requests. Forwards only selected MCP headers, not client-invented X-Forwarded-IP or Cookie; does not log raw bearer/token/body. If local Hub is down, returns 502. No secret or private endpoint contents stored.
- Defaults are MAX_CONCURRENT=32 and MAX_REQUEST_BYTES=1 MiB, with a bounded upstream connection timeout. MCP GET is disabled because existing Hub disables it. Streaming/SSE compatibility still requires provider tests.
- Optional --public-host=pc.example.com only *validates* which Host headers may arrive from an independently configured named outbound tunnel. It NEVER creates DNS or opens a public connection. It refuses trycloudflare.com quick tunnel hostnames. Before accepting public-host, CLI also requires exact HTTPS NEXOWIRE_MCP_RESOURCE_URL=https://pc.example.com/mcp, trusted configured control-plane OAuth+metering, and a read-only local Hub health plus protected-resource metadata check verifying OAuth is actually configured and exactly matches the public resource.
- The proxy verifies bearer presence/format only; it never replaces the trusted Hub's actual OAuth token validation, device ownership checks, quotas or replay ledger.

## Developer preview (loopback only)

From a separate isolated, authenticated test Hub already running on the same PC:

    nexowire local-first ingress --listen-port=43111

This creates only a localhost endpoint (127.0.0.1:43111/mcp), with NO public hostname. Use separate test Hub + port rather than contacting the user's active Hub on a real desktop.

For reviewed public-host staging, after first-party OAuth and trusted metering are configured on the preexisting local Hub, the CLI shape is:

    nexowire local-first ingress --listen-port=43111 --public-host=pc.example.com

A separately configured stable outbound tunnel must route the matching HTTPS hostname to http://127.0.0.1:43111. DO NOT send a tunnel straight to 43110: that port also hosts /agent. This stage does not install cloudflared, allocate DNS or attach ChatGPT accounts. OAuth/Windows secrets must be stored in platform-protected sources, never copied into logs, arguments or URLs.

## Anywhere in the world: what must still be achieved

1. ChatGPT connects to a remote HTTPS MCP endpoint, not directly to localhost. Choose a first-party supported secure connection: stable Cloudflare named Tunnel + domain OR an eligible OpenAI Secure MCP Tunnel. Validate account access to each option, naming and service terms. A disposable trycloudflare.com Quick Tunnel is DEVELOPMENT ONLY and lacks SSE, offers no uptime SLA and has a 200 in-flight request limit. This PR does not provision any of them.
2. Each user's machine must be online and running its single enrolled Nexowire Native Agent. For local-first personal mode, integrate an authenticated local Hub/MCP into the existing installation; avoid a second Agent process or a hidden per-user VPS. The previous outbound Agent to the owner Hub remains the default compatibility route.
3. Free/Plus/Pro future logical daily call limits (1000/5000/10000) are NOT live; current Free-only 1000 weighted/month remains active. A malicious owner can edit local SQLite/token checks: a commercial global quota requires a TRUSTED owner-operated existing metering Hub or independently trusted ingress ledger. Per-user direct tunnel with purely local quota cannot enforce commercial plan limits against the computer owner, though it is suitable for a clearly unmetered personal/self-hosted mode.
4. Public hostname, HTTPS, tunnel owner pairing, signed releases, account-wide logout and device authorization, NAT/CGNAT, streaming cancellation/reconnect, iOS/Android ChatGPT, multi-PC user routing and stable endpoint registration MUST be verified on separated devices and networks before any public rollout.
5. Zero NEW operator cloud invoice remains hard; domain, user's ISP, electricity and hardware are not intrinsically free. Large data services may have separate Cloudflare terms, and user machine performance can cap tool throughput even if the ingress proxy is idle.

## Verification and release boundaries

Windows Node 22+: 11/11 isolated ingress tests passed, verifying allowed MCP forwarding, forbidden /agent/admin, invalid Host/Origin, missing bearer, 413 and 502 fallbacks, quick tunnel/wildcard rejection and current trusted OAuth metadata preflight. TypeScript and build pass. Tests use a fake loopback Hub, no live user actions, no Internet tunnel or Cloudflare mutation.

NOT DONE: named tunnel registration, real external browser/ChatGPT MCP test, provider-supported OAuth login/refresh, one-click enrollment and local self-hosted owner quota admission, actual per-user cross-country latency, bandwidth and billable request measurement, sustained 10M/day PC benchmark, secure Agent-side in-flight revocation and rollback under a remote outage.

Proposed next gates:
Z1 isolated loopback auth + tool contract regression; Z2 stable zero-cloud-invoice outbound tunnel staging with valid ChatGPT and OAuth credential; Z3 self-hosted authoritative account quota / no Worker per tool; Z4 multi-region network + hardware load; Z5 reviewed canary with one-command rollback. Do not treat this code or a merged PR as live availability.

External references:
https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
https://developers.cloudflare.com/tunnel/get-started/
https://developers.cloudflare.com/tunnel/concepts/routing/
https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
