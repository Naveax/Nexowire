# Scale v2 — Signed device-to-owner quota RPC (S2, localhost STAGING ONLY)

**2026-10-16.** Staging proof based on owner-quota PR #517's independent source/test schema, to be rebased onto its merged main. This is **NOT** a public or production network endpoint. The real Free plan still has **1,000 weighted credits per UTC month**; proposed Free/Plus/Pro daily and Custom 100..850,000/day are OFF. No subscription, payment, Cloudflare, Tailscale, live Hub or Native Agent settings are changed.

## Trust boundary and responsibilities

- The trusted OWNER computer hosts the authority and its SQLite file. The user computer does **NOT** receive the commercial quota DB or owner signing key. The only prototype HTTP listener is inside `startProposedOwnerQuotaLoopbackRpc`, bound internally to **127.0.0.1 with a random ephemeral port**. It is not routable from another city and is not registered as a public MCP endpoint.
- Individual native devices can hold their own **device Ed25519 private key**, separate from the owner-operator route signing key from PR #516. The owner database pins the matching revocable **public** device key. These device credentials are illustrative DEV-only; real issuance, TPM/DPAPI storage, revocation, key rotation, onboarding and lost-device recovery are not provided.
- `POST /internal/owner-quota/v1/reserve` accepts a **strict**, signed, canonical request with device ID, 128-char-or-shorter unique nonce, timestamp, actual invocation ID, chosen allowed `toolId` and first-party bearer. Signature domain separation binds the method/path and body fields; alternate paths, unsigned extra fields, oversized bodies and unsupported request types fail closed. The owner resolves `toolId` to the **owner-controlled** canonical tool fingerprint and read/write operation class; the device cannot grant itself a privileged class or price/plan/limit.
- The server verifies the device's pinned Ed25519 key and active status and applies a **30-second** clock freshness check. `BEGIN IMMEDIATE` commits each nonce once, so same signed request cannot authorize multiple attempts. A nonce is consumed even if its first-party token is invalid. A **trusted monotonic wall-clock guard** denies clock rollback; records older than 180 seconds are pruned, since their signed requests have become unusable, avoiding indefinite replay-row growth.
- After signature and nonce admission, the prior `ProposedTrustedOwnerQuotaAuthority` still authenticates the bearer on the owner side, rechecks account session generation, device ownership, Safe versus Full access and account's current plan and reserves one logical call. An accepted RPC decision has `authorizesToolExecution:false`; this is **not** a native tool execution grant, a payment receipt, a subscription or a permission to skip broker approval.
- This INTERNAL RPC is deliberately not charged against the OpenAI Secure MCP Tunnel **600/min all-ingress** transport budget again: that upstream budget is counted at the MCP ingress when the request first arrives. Doing both would artificially double throttle, and a local 429 cannot undo OpenAI's upstream accounting.

## Tests and observed proof

`test/owner-quota-loopback-rpc-staging.test.ts`: **16/16 localhost HTTP + SQLite tests PASS**, including:
- server loopback binding, signed legitimate device and authenticated account;
- two devices share same account counter, Safe-mode write denied and no duplicate logical tool charge;
- same network nonce replay denied, forged body, wrong device key, extra unsigned plan/account/operation fields denied;
- failure of first-party bearer, revoked device key or account epoch;
- unknown tool ID denied by owner catalogue;
- expired/future signed requests, bad method/path/content type and oversize body denied;
- forged X-Forwarded/Origin headers do not change owner or device;
- database unavailable fail-closed;
- concurrent distinct device requests share the durable account counter;
- old nonce cleanup plus global owner-clock rollback denied.

The device signing function `signDevOwnerQuotaRpcEnvelope` is a DEV/test helper, NOT production key custody. Test keys are ephemeral and never deployed. Tests are mocked localhost only; they do not demonstrate remote service access, actual provider metadata, signed transaction receipts after reconnection or 850k/day real throughput.

## Production NO-GO and next acceptance stages

1. Production account/device private key issuance and secure device storage with authenticated enrollment/recovery, key rotation, account transfer and revocation. **Never put the owner operator signing key on customer PCs.**
2. Connect remote devices ONLY over trusted TLS 1.3/mTLS or a user-approved authenticated VPN/private overlay or named outgoing tunnel to the **owner server's localhost origin**. Test actual certificate chain/hostname, channel authentication, identity binding and downgrade resistance. Do not expose raw `/agent`, owner SQLite or localhost plaintext RPC on a public interface. Current real Work PC Funnel still routes old Hub 43110; do not change it automatically.
3. Replace the test OAuth verifier with trusted first-party session epoch/token validation and user consent, and prove per-command broker permission/revocation independently, including in-flight actions.
4. Add owner-side RPC metrics and issuer availability/soak: CPU, lock contention, 600/min ingress, 850k/day actual logical tools, connection drops, bandwidth and disk budget/retention for 100+ simultaneous users. Confirm no incremental operator cloud invoice in real deployment.
5. Implement legal/meter plans separately: current production Free 1000 weighted **per MONTH**; proposed Free 1000/day, Plus 5000/day, Pro 10000/day, Custom 100..850000/day remain OFF, checkout/billing OFF.

**Release status:** Code and mock localhost transport proof only, **NO public deployment**.
