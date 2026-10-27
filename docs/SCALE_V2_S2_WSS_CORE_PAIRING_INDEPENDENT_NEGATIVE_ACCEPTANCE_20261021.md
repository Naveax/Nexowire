# Nexowire #13: independent WSS signing, pairing and CORE preference boundary

Date: 2026-10-21. Base source: main 4c5c810134c020cd04a5ef2be5c1138ea1954ad0. **SOURCE QA ONLY / PRODUCTION NO-GO**.

## Independent #612 code and CI review

DRAFT PR #612 HEAD ed7b6a9638fd3f9b7bf86e4dca7f5047fb7a5798, CI 39597637188 completed SUCCESS. Only staging issuer implementation, its tests, and existing acceptance report were changed.

- At issue() start, primitive bearerToken/deviceId/nonce/signedAtMs/deviceSignature values are copied before async owner authentication; all signed canonical bytes, signature checks, account/device lookup, replay row insertion and operator-signed receipt device ID use pinned fields.
- No WSS transport, control-plane CORE policy, device Broker, Agent installation or Cloudflare edits were introduced by #612.
- Prior regression shows in-process mutable-input race where same-owner synthetic devices sharing an Ed25519 public key could switch signed device identity; another mutation could switch nonce replay-record key. #612 source tests cover both and stale authority.
- Reviewed source delta and exact-head green CI: **recommend #612 for source-only merge after independent reviewer approval and repository owner gate**. CI green does NOT authorize production deployment.

## New independent integration-only tests

File: test/owner-public-wss-core-grant-boundary-regression.test.ts.

1. A synthetic valid operator-signed WSS enrollment, pair token, paired device credential or copied signature cannot be used as the separately authenticated owner HTTP bearer session to set CORE. Wrong/forged owner token 401, service role 403, alternate owner 404. Correct owner session plus typed confirmation sets desired preference but still returns persistentMaintenance.active=false; repeated owner HTTP request never becomes privileged execution. SAFE turns preference off.
2. Consumed pairing token cannot re-pair the device. Owner/device mismatch, wrong operator signing public key, stale session generation, profile revision rollback or expired receipt reject before owner WSS trust adoption.
3. Independent trusted owner key rotation/revocation invalidates an established WSS lease permanently. Restoring an earlier trusted context cannot reactivate it. Session generation bump also denies; restoration does not resurrect the lease.
4. Synthetic OpenSSL certificates with SAN DNS:edge.example.com check two-SPKI pin rotation on a signed operator profile. Wrong SAN/SNI and tampered pin without an operator resign are rejected. Source WSS route is exactly /internal/owner-quota/v1/outbound. Resulting client options refuse redirects, insecure TLS and compression and require TLS1.3. Local generated certs are erased on test cleanup. Certificate test skips only when OpenSSL is unavailable.

Test suite: owner-public-wss-* plus owner-quota-* plus core-preference and product-pairing; on Work PC 153/153 PASS before source branch upload.

## Key distinctions / release blockers

- WSS enrollment signature is identity/trust-profile evidence, not a CORE grant. A user-authorized CORE UI preference is **NOT** an effective Windows high-integrity token, OS elevation or live signed Broker grant. active:false remains correct for all synthetic tests.
- Typed confirmation is an owner UI action, NOT cryptographic one-time signed approval. Authenticated repetition may re-save preference; it does not provide native elevation. Do not claim real CORE grant nonce/replay acceptance until a separately attested signed Broker authority exists.
- Token identity in tests is independently supplied by explicit synthetic bearer-token mapping, not claimed HTTP headers. This does not prove real OAuth issuer/refresh/revoke authentication or real owner device pairing at Cloudflare.
- CNG Software/Platform KSP ED25519 was unsupported on previously probed physical Windows hosts (0x80090029). ECDSA P-256 algorithm support and DPAPI CurrentUser encryption do not prove a non-exportable TPM device key or approved v2 migration.
- No operator-owned Named Cloudflare Tunnel/account/zone, production hostname/TLS certificate or rotation control was inspected. All certs, keys, authority and network contexts are synthetic/local.
- #551 installer/high-token/ACL/canary, #617 CORE elevated Broker, #596 durable streaming, and true 100+ authenticated concurrent clients are independently BLOCKED. Never infer their acceptance from this QA.
- No live Cloudflare, OAuth, TPM, Agent, Broker, UAC, Windows service, DNS, certificate or token operations were performed.

**Verdict: source-level #612 approval recommended after code-owner signoff; production NO-GO, physical/staging gates outstanding.**
