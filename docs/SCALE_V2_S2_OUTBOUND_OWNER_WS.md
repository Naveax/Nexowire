# Scale v2 S2 — Client-initiated outbound owner-quota WebSocket (DEV/STAGING)

**2026-10-16.** The last Tailscale-only staging proxy PR #520 passed exact-head **7/7 GitHub CI** and was guarded-squash merged to verified main `519d786ca631d79c206ff2212ac5054d37e7faf2`. This document covers a new **code-only** prototype of an alternative network topology with **no inbound port required on the customer's PC**, which could later work under CGNAT and arbitrary locations once a real authenticated public **WSS/TLS** edge is deployed and verified.

## Separation of authentication, remote transport and native execution

The intended flow is `Customer device (outbound WSS only) → trusted owner ingress endpoint → fixed owner-local quota RPC → authoritative owner database`. The customer's Native Agent executes permitted tools locally through its **existing** authorization/Broker boundaries. A WebSocket is neither native OS permission nor a subscription; `authorizesToolExecution:false` always remains true in the quota decision.

**IMPORTANT:** The new staging server `startProposedOwnerQuotaOutboundWsHub` listens on **127.0.0.1 with a random ephemeral port**, never publicly; the client `ProposedOutboundQuotaWsClient` dials **ws://127.0.0.1 only**. This mock uses plaintext solely on local loopback. It does **NOT** add a production WSS public hostname, Cloudflare routing, TLS certificates, DNS, Agent startup, Tailscale Serve/Funnel, or billing. Arbitrary Internet or two physical PCs are **not yet proven** with this code.

## Implementation in this PR

- `src/product/owner-quota-outbound-ws-proposal.ts`: existing project dependency `ws`; HTTP loopback server accepts only WebSocket upgrade `GET /internal/owner-quota/v1/outbound`. All other HTTP/upgrade paths including `/agent` are rejected. The strict v1 `reserve` frame contains a correlation ID and **unchanged** existing #518 Ed25519-signed device quota envelope, not native command payload.
- The owner bridge relays the signed envelope with a **fixed upstream** `http://127.0.0.1:<port>/internal/owner-quota/v1/reserve`, already validated by the prior SSRF-resistant owner RPC destination checker. It forwards **no user-supplied Host, session cookies, Authorization, device impersonation headers, or target URL**. Owner RPC continues verifying pinned/active device Ed25519 key, freshness and once-only nonce, first-party OAuth account session epoch, device ownership+Safe/Full access and current server-trusted subscription quota. WebSocket connection alone does **not** authenticate the sender.
- Per-socket pending frame budget **16**, server max connections **16**, frame/response cap **16 KiB**, upstream timeout **4s**, strict message schema and bounded response streaming. The client tracks correlation IDs to avoid late responses fulfilling reused request IDs. Any more than 100,000 unique correlation IDs on the same connection causes fail-closed rotation rather than forgetting old IDs. Close/transport failures reject all uncompleted promises.
- The client does **not** silently retry a signed, potentially side-effectful operation. After a disconnection the caller must explicitly generate a new signed nonce but preserve the original **logical invocation ID**. The owner shared replay ledger from PR #517 then returns `duplicate` without consuming another daily credit. This avoids both replay acceptance and duplicate charging, but does not prove completed tool execution or exactly-once effects.
- The WebSocket transport **does not** add another 600/minute usage meter. The canonical OpenAI Secure MCP Tunnel (tunnel + calling app) all-ingress 600/minute budget belongs upstream of this private quota channel, with current plan allowance an independent logical tool counter. This stage does not bypass OpenAI request limits.
- Does not import into the production CLI/Hub/Agent; no customer keys are saved in this repository. DEV Ed25519 keys and OAuth stub credentials are created inside isolated unit tests only.

## Test evidence

`test/owner-quota-outbound-ws-staging.test.ts` **12/12 PASS** on Windows / Node 24 test host, exercising *real localhost WebSocket and real owner RPC backed by in-memory SQLite*, not a mocked quota decision:
- client opens **outbound** socket, no inbound port on client; server binds to loopback; invalid URLs disallowed;
- signed device quota request reserves exactly one unit, never authorizes tool execution;
- signature replay denial, reconnection with fresh signed nonce + original logical invocation ID leads to `duplicate` without double charge;
- two independent client sockets/devices share the same authenticated account daily quota;
- wrong private key, disabled device, Safe-mode writes and revoked account OAuth epoch fail;
- `/agent` upgrade and malformed frames rejected without calling RPC;
- client correlation-ID reuse refused; storage unavailable fails closed.

The localhost tests do not attest actual remote geography, WSS hostname/certificate verification, real OpenAI caller identity, production OAuth, device enrollment, cost-free high availability or genuine 850,000 daily completed tool executions.

## Real rollout gates and operational economics

1. **Use outbound WSS/TLS 1.3** with strict hostname validation, authenticated service identity and known public endpoint. Complete first-party verified OAuth, trusted account/device enrollment, public-key custody/rotation and bidirectional session revocation, plus authorizing individual native commands. Do not serve `ws://` remotely or expose raw customer `/agent`, owner SQLite or unencrypted owner RPC.
2. Prove **two distinct PCs in different locations** can connect using independently authorized client credentials, with no customer inbound port/NAT changes, and survive reconnect/packet loss/offline operation without double-charge or command re-execution. Real ChatGPT MCP tool calls remain a separate end-to-end scenario, as OpenAI's Secure MCP Tunnel may account for requests before our origin.
3. The shared central service is a **resource and cost bottleneck**: owner PC uptime, upload bandwidth, TLS/WebSocket connection count and frequency, SQLite single-writer lock time, connection fan-out, CPU/RAM/IO, retention and failure recovery. No zero-cost guarantee follows just from moving tool execution to user PCs.
4. Arbitrary customers should **not be forced into the owner's Tailscale private network**. Use a vetted public HTTPS/WSS frontend with a sustainable operational plan; published Cloudflare free worker and request limits apply. Do not claim unlimited free hosted connections or 850k/day guaranteed throughput.
5. Current Free remains **1,000 weighted tool credits per month**; future per-day Free 1,000, Plus 5,000, Pro 10,000 and Custom Usage 100..850,000 OFF, live checkout OFF. Approval of actual legal sales terms, 600/min provider metrics, high-volume 24h remote load and **measured zero operator incremental cloud invoice** remain NO-GO.

**Status: DEV / STAGING.** No public WSS server or actual customer connection is started by this PR.
