# S2 public WSS trust → signed owner-quota RPC integration (DEV ONLY)

**2026-10-17.** Separate isolated test stage following PR #525's public WSS TLS1.3 hostname/CA/SPKI trust boundary. **No public DNS or Internet socket** was created or connected. This does not replace OpenAI's public `/mcp` endpoint. The operator quota backhaul remains a distinct internal protocol.

## What is verified

`test/owner-public-wss-signed-quota-loopback.test.ts` connects the **actual existing** development owner WSS server to the **actual** owner HTTP RPC and **in-memory** SQLite daily quota authority. It uses a one-day OpenSSL test certificate with DNS SAN `edge.example.com`, a DEV-generated Ed25519 device signing key, a synthetic first-party bearer and a 100/day test-only owner account.

The test deliberately targets the WSS listener's ephemeral `127.0.0.1` socket while explicitly setting TLS SNI to the operator-trusted example hostname, then uses the **unmodified real** `createOwnerPublicWssClientOptions` CA/hostname/SPKI trust enforcement. This temporary test-only TCP routing override is **not exported as a production feature** and MUST NOT be used as a customer DNS bypass. The eventual live client must connect to the exact authenticated operator provisioned `wss://<verified-domain>/internal/owner-quota/v1/outbound` on TLS port 443 without redirect or hostname override.

- Valid pinned CA+DNS SAN+SPKI and TLS1.3 WSS upgrade carries an Ed25519 device-signed quota frame through the owner-local RPC to authoritative SQLite: `HTTP 200 reserved`, daily used=1, `authorizesToolExecution:false`.
- Replaying the **same signed nonce** over a new WSS message returns `HTTP 409`.
- Resigning with a fresh nonce while preserving the original logical invocation ID returns `HTTP 200 duplicate`; daily used remains 1.
- Wrong operator SPKI pin, wrong trusted CA and wrong SNI TLS hostname each fail at the handshake and do **not** reserve quota.
- Synthetic keys/certificate/tmp data are discarded after the test; no secret or active customer info is committed.

## Boundaries and remaining NO-GO

This is one-PC loopback integration, **not** a physically remote or public Internet WSS result. A Tailscale operator-only two-PC signed request had been independently observed in #523/#524, which also does **not** count as general public customer access.

Still need a real registered public WSS domain and authenticated operator TLS endpoint; genuine subscription OAuth/user/device enrollment and secure key custody, rotation/revocation; Cloudflare zero-new-invoice verification and service uptime/traffic routing; provider-verified OpenAI Secure MCP Tunnel caller identity and shared default 600 incoming requests/min; simultaneous multi-user 24-hour actual tool workload and honest 850,000/day measured capacity. The default 600/min upstream ceiling cannot guarantee 850k completed daily tool calls merely from a faster owner SQLite.

No changes to production Agents/Hub/Broker, Cloudflare, Tailscale, Funnel, paid plans, migrations or service startup. Live Free remains **1,000 weighted credits per UTC month**; future daily Free/Plus/Pro and Custom Usage 100..850k OFF.

**Status: DEV test acceptance of TLS trust + signed quota chain ONLY.**
