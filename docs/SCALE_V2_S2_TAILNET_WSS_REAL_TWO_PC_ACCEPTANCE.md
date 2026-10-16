# Scale v2 S2 — Actual two-PC private-overlay TLS 1.3 WSS acceptance (STAGING)

**2026-10-17.** This staging slice follows verified `main=133335a5c03b672a7b3c4899eea9cdea7dd28da5` from TLS1.3 certificate-pinning PR #522 (exact-head GitHub CI 7/7 and guarded squash merge). Real connection was made between two separate authorized Windows computers: **Naveax as client, Work PC as owner quota host**. This document carefully distinguishes that evidence from unsupported general public multi-customer access.

## Code boundary

`src/product/owner-quota-outbound-ws-proposal.ts` adds an **explicit, TEST/STAGING-only** optional Tailnet binding to the existing owner WSS hub:

- A non-loopback WSS listener is permitted only with TLS1.3 configuration, and only if a **single real local OS Tailscale adapter** has the **operator-pinned IPv4** in `100.64.0.0/10`. The listener binds **only that private overlay address** with a randomized port, not 0.0.0.0, public WAN, ordinary LAN or the existing Hub. The socket must be received on exactly the pinned local interface; inbound peer must have a 100.64/10 Tailscale address. That prefix is a routing check, **NOT standalone sender authentication**.
- The outbound client optionally takes a trusted `expectedTailscaleIPv4` in addition to the owner's CA and SHA256 leaf pin. Non-loopback WSS only matches that exact trusted endpoint; plain ws, different IP, query fragments, credentials, arbitrary routes, `/agent`, etc. are refused.
- Node TLS validates **CA chain and exact IPv4 SAN / hostname**, then compares the **operator-provided** leaf SHA256 pin. TLS versions other than **1.3** are forbidden. When not using the explicitly pinned Tailnet option, the existing loopback `ws://` and `wss://` test behavior remains unchanged.
- Application authorization is unchanged: WS does not grant tool execution. The existing owner RPC re-verifies the exact signed Ed25519 device-envelope bytes, pinned device public key, nonce and time, first-party OAuth **TEST** principal/epoch, owner/device Safe/Full mode and server-owned daily plan. A `reserved` response reports `authorizesToolExecution:false`, and repeating the same signed nonce returns HTTP **409**.

## Actual two-PC acceptance performed

**Result: PASS for isolated private-network WSS + owner quota reservation and replay refusal**, not a production rollout.

- Work PC started the **disposable owner fixture** from `test/fixtures/scale-v2-tailnet-wss-owner-smoke.ts` via the Nexowire dedicated managed-process capability. Its in-memory fake account, ephemeral Ed25519 device key, randomly generated synthetic bearer, 1-day DEV self-signed RSA test certificate and **ephemeral Tailnet-only TLS 1.3 WSS port** did not touch any live plan, Agent, Hub, Broker, Tailscale Serve/Funnel, Windows firewall or Cloudflare route.
- Naveax launched a temporary local Python **websocket-client** over the existing authenticated Tailscale/WireGuard overlay. The caller checked the DEV CA chain, **IP SAN**, exact leaf SHA256 pin and negotiated **TLSv1.3** before submitting the signed *read-only quota reservation* envelope.
- On the **actual second physical machine**, the first request received **HTTP 200 + `decision=reserved` + `authorizesToolExecution=false`**. A second submission with the identical signed envelope received **HTTP 409 (one-use signed nonce replay denied)**. Neither action executed any Windows native command.
- The DEV fixture intentionally **generated the signed device request on the owner host** and transferred the short-lived signed envelope to Naveax to test the network channel. This proves end-to-end signature **verification** and replay enforcement across two hosts, **NOT** device-held private-key issuance/proof-of-possession across a production enrollment channel. Real client-side signing/secure key custody is an additional gate. The test OAuth bearer was synthetic, not a real production account or ChatGPT OAuth credential.
- The managed Work PC test process was stopped, and any interrupted-shutdown residue was explicitly removed. Verified on Work PC: **no smoke Node processes, no readiness file, no ephemeral certificate/private-key directory**. Verified on Naveax: temporary client Python script and signed envelope config removed. No permanent network listener/firewall/DNS change.

## Reproducible DEV components

- `test/owner-quota-tailnet-wss-staging.test.ts`: **4/4 new staging tests** of exact operator-pinned private address, refusal of LAN/public/untrusted IP, TLS mandatory for Tailnet binding, and inability to create an outbound Tailnet WSS connection without CA/pin. On a machine with no Tailscale interface, its invalid-address tests deliberately fail closed without listening.
- `test/fixtures/scale-v2-tailnet-wss-owner-smoke.ts`: disposable, manually invoked integration fixture. Requires environment variable `NEXOWIRE_DEV_TAILSCALE_IP` (not committed with any machine's actual IP). Generates keys/certs under OS temp, uses an **in-memory** owner quota DB and automatically stops after 75 seconds. **Warning:** forcefully killing the process may prevent JavaScript `finally` cleanup. Always verify and clean the dedicated test-specific temp folder/readiness file after any forced termination. Never use test keys/bearers for real users.
- Prior `test/owner-quota-wss-tls-staging.test.ts` has 8 real local TLS tests for CA/pin/IP-SAN/TLS downgrade, while earlier WS/RPC/quota/checkout suites remain intact.
- Exact Windows combined stage acceptance: **151/151 PASS, 0 skipped**, TypeScript, build, continuation and AI Screen launch audit and staged Git whitespace PASS. Live AI Screen audit retains an unrelated unchanged warning; this is not an approval of native process isolation.

## Still NOT production-ready

1. **Any location for any customer** remains unimplemented as public service: this acceptance requires both PCs to belong to an **existing authorized private Tailscale network**. Public customer onboarding cannot assume joining the operator tailnet or bypass platform/provider usage restrictions. The next architecture must provide reviewed stable first-party TLS 1.3 **public WSS** with audited OAuth, tenant isolation and secure outbound client authentication, without exposing `/agent` or raw owner DB.
2. User-specific device-held private keys and trusted enrollment, key rotation/compromise recovery, real first-party account/session/device consent and native Broker per-command security gates, current revocation and reliable reconnect/delivery. Never put the owner-route signing key on customer PCs.
3. Independently verified OpenAI Secure MCP Tunnel calling-app/tunnel identity and authoritative **600 incoming provider MCP requests/min** accounting **before** local admission, including metadata/auth failures and retries; no evasion by multiple tunnels.
4. Owner host economics and operational load: actual 850,000 daily calls and 600/min owner or provider ceiling over 24 hours with concurrency, upload bandwidth, SQLite lock contention, offline/recovery/metrics, failover and a **measured** zero incremental cloud invoice. Even the nominal 864,000/minute-derived daily maximum leaves little headroom for non-tool requests; throughput is **NOT guaranteed**.
5. **Production unchanged**: Free-only current allowance **1,000 weighted credits per month**. Proposed future daily Free/Plus/Pro and selectable Custom 100–850,000/day remain OFF; real checkout/subscriptions/consent rollout OFF. No live Agent, Broker, Hub, Cloudflare or existing tunnel configuration was altered.

**Release judgment: real PRIVATE-network signed WSS transport acceptance PASS; general-public SaaS production acceptance remains NO-GO.**
