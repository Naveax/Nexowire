# Scale v2 S2 — TLS 1.3 / certificate-pinned outbound WSS staging

**2026-10-17, DEV/STAGING ONLY.** Based on verified `main=67c49ee90e2d07db9aa517c366fe0cb4da627d67`, after PR #521's exact-head 7/7 GitHub CI and guarded squash merge. This change adds a **TLS 1.3 handshake and pinned certificate identity** to the existing **client-initiated outbound** WebSocket owner-quota path, but the server remains **bound to 127.0.0.1 only** with an ephemeral port. The user PC does NOT need to accept incoming Internet connections.

## Trusted link contract

- The existing `startProposedOwnerQuotaOutboundWsHub` accepts an **opt-in staging TLS config** of private key PEM + certificate PEM. It hosts the same single-purpose signed owner-quota WS path over `wss://127.0.0.1:<ephemeral-port>/internal/owner-quota/v1/outbound` with **minimum and maximum TLS 1.3**. When the option is not passed, the unchanged legacy `ws://127.0.0.1` staging test behavior remains available. It DOES NOT bind to a public host, install system credentials, enable a new port on a firewall, touch a Cloudflare/Tailscale/Funnel DNS route or expose the Hub's `/agent` WebSocket.
- `ProposedOutboundQuotaWsClient` when given a `StagingOwnerWssIdentity` requires **exactly WSS on 127.0.0.1** and a trusted **operator-supplied CA certificate plus expected 64-digit SHA-256 leaf fingerprint**. The TLS client has `rejectUnauthorized:true`, TLS 1.3 only, and explicitly calls Node's standard `checkServerIdentity(host,cert)` for **hostname/IP SAN validation before fingerprint comparison**. A fingerprint by itself is not considered a trustworthy certificate chain or hostname, and the custom CA is not accepted from a network header or untrusted MCP argument.
- For now this deliberately validates only **loopback** and **DOES NOT enable arbitrary public WSS hostnames**. Future production code will need a distinct first-party approved hostname or stable owner control-plane endpoint, genuine CA issuance or securely distributed pin/rotation chain, automatic renewal, official client support, proxy/upgrade policy and signed owner-mapping.
- The secure WebSocket still carries only the original **Ed25519-signed device quota envelope**. A connected WSS channel is not authorization for an account, device, native tool, Broker or subscription. The prior owner RPC checks device signature and revocable public key, one-time nonce, server-owned first-party session epoch, device owner Safe vs Full access mode and daily plan. The reply carries `authorizesToolExecution:false`.
- The shared default **OpenAI Secure MCP Tunnel 600 ingress requests/min** remains a provider-side gate upstream of Nexowire's owner-quota RPC. The local WSS session does not create additional upstream platform capacity or guarantee 850,000 completed daily tool actions.

## Tests

`test/owner-quota-wss-tls-staging.test.ts` generates **ephemeral one-day DEV self-signed certificates/private keys** at test execution with OpenSSL in the OS temporary directory and deletes them at completion. **NO TEST OR PRODUCTION PRIVATE KEY/CERTIFICATE IS COMMITTED.** On hosts without an executable OpenSSL binary the TLS handshake cases explicitly **SKIP**, rather than pretending a cryptographic handshake was tested. Node versions 22+ are required.

The suite covers a genuine local TLS 1.3 / WSS -> Ed25519-signed owner RPC -> trusted SQLite daily quota reservation, nonce replay and idempotent logical call, strict CA, leaf fingerprint pin, wrong SAN/hostname, URL/protocol refusal and TLS 1.2 downgrade denial. Read exact local and CI results separately; do not claim an e2e cross-country or public WSS acceptance merely because local tests passed.

## No-go for production

1. Operator-owned valid public WSS hostname and actual TLS 1.3 ingress with CA chain, optional pin rollovers, cert renewal, secrets storage, OAuth and stable DNS; no extra operator cloud provider charges unless transparently approved. `ws://` is NEVER appropriate across the open Internet.
2. End-to-end **two physically different PCs** behind their normal networks, using an approved secure outbound connection, actual TLS hostname validation, first-party account/device registration and idempotent real tool calls. Legacy Tailscale peer ping is not equivalent to HTTP/WSS success.
3. Authenticated verified OpenAI Secure MCP Tunnel caller metadata, shared 600/min provider upstream telemetry, canonical per-account daily quota, native execution/Broker authorization and timely session/device revocation.
4. Actual 850,000 daily logical tool requests with transport overhead/metadata/retries, 24-hour soak, reconnect, CPU/RAM/disk/network contention and zero incremental provider-invoice proof. The number is a **ceiling requested by the user**, not confirmed execution throughput.
5. Current production Free remains **1,000 weighted credits per UTC MONTH**. Future daily Free 1,000, Plus 5,000, Pro 10,000 and Custom 100..850,000/day plus production checkout/billing and legal terms are **OFF**.

**Status: staging code only; no actual Internet-facing WSS or new live Agent/Hub port.**
