# P0 Scale v2 S2 - protected device key and Named Tunnel acceptance

**Date:** 2026-10-18. **Status:** STAGING / PRODUCTION NO-GO.
**Already merged:** PR #537 and #546. No changes to live Agent, Hub, Broker, OAuth, DNS or Cloudflare tokens.

## Source and test scope

- owner-public-wss-device-signer-proposal.ts snapshots nonce, device ID, bearer and timestamp before any asynchronous signer callback. The callback receives a separate copy of canonical bytes. Caller request mutations and callback buffer mutations cannot change the returned signed proof.
- owner-public-wss-windows-dpapi-staging.ts provisions only a test private key in an OS temporary folder, protected by DPAPI CurrentUser and purpose-bound to owner account/device IDs. It refuses overwrite. Reopening for signing decrypts private material inside Node: this is NOT a nonexportable hardware key, TPM or production-ready ACL boundary.
- owner-public-wss-named-tunnel-preflight-proposal.ts checks offline metadata and trust profile syntax, while always denying production acceptance. It makes no authenticated Cloudflare request, DNS change, or tunnel.
- owner-public-wss-signed-quota-loopback.test.ts deterministically drops the application-visible ACK after owner reservation. Reconnected replay with the original signed nonce returns HTTP 409, while a new nonce with the same logical invocation returns duplicate without charging twice; native execution remains unauthorized.

## Physical evidence

- Work PC read-only OS probe returned Microsoft Windows NT 10.0.19045 and Naveax Microsoft Windows NT 10.0.22631. TPM property values were empty in both reads: TPM state and KSP capability are **unverified**, not assumed absent.
- Work PC synthetic DPAPI CurrentUser key test: encrypted disk envelope, signer reopen under same user, wrong owner/device/pin rejection, original test directory deleted in finally. No cross-user, restart or production key-protection proof.
- Keys/tokens were synthetic and transient. No production process or credentials changed.

## Release gate matrix

| Gate | Staging evidence | Required production evidence | Status |
| --- | --- | --- | --- |
| Async signer canonical TOCTOU | Snapshot and separate canonical buffer, mutation tests | Native signer integration | Staging PASS |
| DPAPI protected Ed25519 at rest | Physical same-user temporary-file test | ACL, different-user denial, reboot, service-identity test | PARTIAL |
| CNG/TPM nonexportable device key | Not implemented | Provider algorithm support plus nonexportable key validation | BLOCKED |
| Key rotation, revoke, session lease | Existing #537/#546 suites and new PoP tests | Real issuer/session revocation and genuine hardware keys | PARTIAL |
| Wrong owner/device, nonce, replay, ACK loss | Existing identity suites and synthetic TLS reconnection | Separate ISP and packet/fault injection | PARTIAL |
| Named Cloudflare tunnel/zone | Offline metadata and hostname checks | Authenticated account, tunnel and ingress read-only inventory | BLOCKED |
| TLS identity and key pinning | CA/SAN/SPKI staging TLS suite | Real operator domain and safe edge certificate rotation | BLOCKED |
| Native Broker grants | Not connected | Server-side execution authority, revocation and rollback | BLOCKED |

## Key algorithm decision

Microsoft documented built-in CNG Software/Platform KSP supported signing algorithms include ECDSA P-256/P-384/P-521 and RSA, but not Ed25519. Do not assume Ed25519 TPM support, silently change signature algorithms or treat DPAPI PEM as nonexportable. A production solution needs an audited compatible HSM/KSP, or explicit versioned protocol migration to a supported hardware signing algorithm with signed algorithm/key ID, algorithm-separated proof framing, anti-downgrade, rotation and revocation. Hardware and user isolation tests are mandatory.

## Named Tunnel operator-controlled READ-ONLY preflight

1. Using authorized read-only Cloudflare account access, independently verify exact account ID, zone ID, named tunnel UUID, operator domain, ingress routes, hostname and Access policy. No create/edit/delete operations.
2. Validate that hostname is within the controlled zone and matches the operator-signed WSS profile, without redirects, arbitrary URLs or Quick Tunnel substitutions.
3. Inspect DNS routing separately and perform CA-validated TLS 1.3 handshake against exact host/SNI/SAN. SPKI pins must be provisioned independently of the connection being tested.
4. Cloudflare-managed edge certificates rotate, so strict SPKI pinning needs an explicitly controlled custom certificate/rotation plan or a reviewed versioned trust policy change. Do not trust an observed pin as an authority.
5. Once operator configuration exists, the read-only commands cloudflared tunnel ingress validate and cloudflared tunnel ingress rule with the intended hostname can check ingress selection. Neither command was run against a real named tunnel here.
6. Require separate-ISP client acceptance, owner/device/session revocation under in-flight requests, native Broker authorization isolation and rollback proof before promoting.

**Outstanding:** authenticated operator Cloudflare account/zone/tunnel; real OAuth issuer; hardware-protected nonexportable key or protocol migration; cross-user ACL tests; native Broker grant lifecycle; separate ISP and sustained production acceptance. No production acceptance is asserted.
