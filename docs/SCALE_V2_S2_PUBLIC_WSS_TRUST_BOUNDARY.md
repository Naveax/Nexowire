# Scale v2 S2: Approved-public-host outbound WSS trust (DEV/STAGING ONLY)

**2026-10-17.** This stage builds on merged physical-PC private Tailscale WSS acceptance PR #523, and is independent of in-progress PR #524 for client-held device private-key proof. Neither production public DNS nor TLS issuance, Cloudflare service, payment, Native Agent, Hub, Broker or active quotas are changed. User's **Free 1,000 weighted credits/month** remains active; planned Free/Plus/Pro daily and Custom 100–850,000/day are OFF.

## Architecture and explicit trust boundaries

A customer PC should eventually initiate **outbound WSS** to an operator-owned stable endpoint; no unsolicited inbound customer PC connection is required. This WSS is an **internal device-to-owner quota backhaul**, **NOT the ChatGPT MCP endpoint**. ChatGPT normally needs an approved HTTPS `/mcp` Streamable HTTP server or a Secure MCP Tunnel. WSS does NOT replace first-party account authentication, MCP OAuth, the provider's own shared tunnel quota, or Native Agent/Broker command authorization.

New isolated module: `src/product/owner-public-wss-trust-proposal.ts`.

- `validateOwnerPublicWssTrustProfile` requires **one exact canonical URL**: `wss://<operator-controlled-domain>/internal/owner-quota/v1/outbound` using standard TLS port 443. The domain name must exactly match an **independently trusted expected hostname**; raw IPv4/IPv6, loopback, LAN, wildcard, alternate port, scheme downgrade, URL credentials, query, fragment or other routes such as `/agent` are forbidden. Client-supplied URL redirects must NEVER change this identity.
- Two trust-root options: **system CA chain** or explicitly provisioned **custom operator CA**. Both require one or two independently provisioned, lowercase hex SHA-256 DER **SPKI public-key pins** (for planned certificate/key rotation). Pin renewal must be an **authenticated operator configuration change**; never accept a pin, hostname, CA, or bypass from a server response, MCP tool input, unauthenticated bootstrap endpoint or user-controlled PC configuration.
- Node HTTPS Agent always enforces **TLS 1.3 only**, `rejectUnauthorized:true`, Node's `checkServerIdentity` hostname/SAN validation and a SHA-256 SPKI pin match. Redirect following and WebSocket per-message compression are disabled; handshake timeout is bounded. A pin alone is not sufficient for chain trust or hostname validation.
- This module returns **client transport trust options only**. It intentionally does not start a public WSS server, create an insecure socket, change DNS or publish arbitrary WebSocket listeners. Device private Ed25519 signing, account OAuth epoch and centralized usage reservation remain separate established staging modules; a WSS connection alone grants **no** native tool execution.

## Verification

`test/owner-public-wss-trust-staging.test.ts` uses ephemeral locally generated one-day OpenSSL certificates in an OS temporary folder, removed after the tests. Tests do not commit a certificate or private key. Six new tests verify domain/path/port restrictions; localhost/LAN/IP/credential/redirect-like inputs fail closed; profile tampering/unsafe CA/bad pins refused; real certificate SAN and SPKI accepted with a two-pin rotation set; certificate pin mismatch and wrong hostname rejected. On environments with no OpenSSL, cryptographic certificate cases explicitly SKIP rather than pretending they passed.

Windows Work-PC test results: **6/6 new PASS, 157/157 combined quota/WS/TLS/private-PC/staging tests PASS with 0 skips**, `npm run typecheck`, `npm run build`, `npm run continuation:check`, `npm run ai-screen:launch-audit`, and whitespace checks PASS. The AI Screen audit's pre-existing isolation warning remains and is not an acceptance of isolated native process execution.

## Production acceptance blockers

1. Obtain verified control of a **stable public WSS domain** with an independently issued/trusted certificate, secure operator provisioning of the exact trusted profile and a reviewed public edge. Secure MCP Tunnel can keep MCP private, but customer onboarding/permissions and official tunnel availability must be checked per workspace.
2. Build an authenticated origin-to-customer connection on ordinary networks with real device-held Ed25519 keys, trusted account enrollment, key custody/rotation, short-lived OAuth/signed authorization, revocation and safe reconnection, plus per-tool Native Broker permissions. A shared WSS is not an authentication mechanism.
3. Prove actual **two physical PCs without a shared operator Tailscale tailnet** can connect through approved public WSS, including NAT/CGNAT, DNS rotation, real TLS/SAN/pin check, replay, disconnection, rate limits and error behavior. Prior two-PC success used only an **already-authorized Tailscale private overlay**.
4. OpenAI Secure MCP Tunnel documented default **600 MCP requests/minute per tunnel+calling application** (user fallback), 120-second deadline, 1,000 pending queue/tunnel and 10 MiB serialized request/response. The absolute 600*1,440 = 864,000 request/day upper bound leaves just 14,000 requests/day headroom at the user's proposed Custom 850,000 ceiling; metadata, auth, listing, retries and provider accounting ALSO consume capacity. This is a **constraint** and NOT a throughput guarantee. Formal load testing, honest consumer documentation, overload control and support-agreed provider limit increases must precede any high-ceiling marketing.
5. Real 24-hour multi-tenant/device load test, bandwidth/CPU/RAM/disk/SQLite lock and connection budget, loss/failover and explicit $0 incremental operator cloud invoice review. The tool execution PC can be local while the authenticated owner control plane remains a separate operational cost point.

**Release status: STAGING / NO-GO for public users.** No production payment, updated plan, Cloudflare/DNS, Hub/Broker/Agent or public tunnel was activated.

Official reference:
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/auth
