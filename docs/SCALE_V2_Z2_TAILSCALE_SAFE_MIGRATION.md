# Scale v2 Z2 — Tailscale Funnel public-route safety preflight (read-only)

Date: 2026-10-15. Follows opt-in MCP-only localhost ingress PR #509. **NO LIVE ROUTE CHANGES.** This stage is a safe prerequisite for anywhere-in-the-world connectivity without opening inbound NAT ports or starting duplicate Nexowire Agents.

## Current Work PC evidence (redacted)

The Work PC already has Tailscale installed, running, online with MagicDNS and no health warnings. Read-only `tailscale funnel status --json` showed **two active public web handlers proxied to 127.0.0.1:43110**, NOT the new safe MCP-only localhost ingress port 43111. 43110 hosts both the protected `/agent` WebSocket and `/mcp` endpoints; the intended new public origin is `http://127.0.0.1:43111`, which rejects all non-MCP paths and WebSocket upgrades. The existing direct exposure may still require bearer tokens, but it is a needless attack surface. We did **not** stop or change the current Funnel, Hub, Broker, Agent, ports, DNS or device state.

## New read-only command

```powershell
nexowire local-first funnel-plan
```

It reads only `tailscale status --json` and `tailscale funnel status --json` using parameterized `execFile` (no shell, no `funnel --bg` or `funnel reset`). It never prints the account/domain/IP/device/token. It reports stable DNS readiness, published route counts and whether routes point to the raw Hub (43110), safe ingress (43111) or unknown destinations. Any unknown public route or format fails closed, every response explicitly sets `readyToExpose:false`, and no network/settings mutations occur.

`src/mcp/local-first-funnel-plan.ts`, `test/local-first-funnel-plan.test.ts`, CLI path `src/cli.ts`. Windows test verified read-only CLI against actual Work PC's current Tailscale JSON, outputting `needs-migration` with **2 direct Hub public handlers**. Read-only Hub `/health` was healthy with **2 connected Agents**, but `ownerOauthConfigured=false`; public cutover remains blocked until an authenticated, metered test Hub is ready. New tests cover no public Funnel, private Serve vs public Funnel, invalid schema, unknown proxy target, protected ingress, disconnected MagicDNS, and no unexpected process arguments. Combined with PR #509 local ingress suite: **20/20 PASS**, TypeScript PASS.

## Safe staged transition (NOT executed)

1. Keep the existing work-pc and Naveax v1.0.5 Agents online; save a secured backup of current Tailscale Funnel route config without copying bearer credentials into issue comments.
2. Start a separate isolated authenticated localhost Hub and the new opt-in MCP-only origin on 127.0.0.1:43111. Verify the internal Hub's trusted OAuth resource metadata, actual authenticated MCP tool admission, rejected `/agent` and correct usage ledger. The proxy's bearer-format check is not equivalent to credential verification.
3. In a disposable Tailscale Funnel test node or a dedicated hostname (not the active production route), bind the public HTTPS entry to the MCP-only origin 43111; verify only POST /mcp and OAuth protected-resource metadata and no `/agent` upgrade. Obtain valid owner-only auth, no unauthorized tool execution or quota bypass. Make sure clients support MCP streamable HTTP, OAuth, connection latency and desired tool actions.
4. Measure Free bandwidth/availability restrictions, whether ChatGPT account/workspace supports full custom MCP and stable public hostname, explicit operator cost constraints, and cross-carrier/CGNAT connections. Test from a separate phone/PC network and verify owner-device routing.
5. Only then plan a time-bounded, owner-approved cutover of the current public Funnel from 43110 to 43111, with a known-good revert to the **secure** previous state. If the old state exposed unwanted /agent, do not blindly restore it as the default without security review.
6. Keep the existing 1,000-weighted-credits/month Free policy until the trusted owner-operated daily limit migration has separate explicit acceptance. Owner-verified GitHub identity may have `monthlyCredits:null`, which is a credit ceiling exemption, not an exemption from security/tool permissions or provider limits.

## Provider limits

Tailscale Funnel is an opt-in public HTTPS exposure with tailnet-owned `.ts.net` domain and non-configurable bandwidth limits; it is NOT infinite capacity and endpoint must be securely authorized.

Official OpenAI Secure MCP Tunnel has a default **600 MCP requests/minute** rate per tunnel/application scope, a **10 MiB serialized payload**, **120 sec request deadline** and **1,000 pending requests**. That default permits at most 864,000 requests/day even at sustained full speed, so it does NOT satisfy a 10,000,000/day stress objective. Increasing the number of clients/tunnels solely to evade these limits is not acceptable.

Sources: https://tailscale.com/docs/features/tailscale-funnel and https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.

## NO-GO

No Tailscale change, no stable public MCP-only hostname provisioned, no remote ChatGPT device-owner acceptance test, no proven free service throughput nor in-flight revocation, no new production Worker/D1 migration or user-plan policy activated. PR #509/#510 staged code is NOT a release.
