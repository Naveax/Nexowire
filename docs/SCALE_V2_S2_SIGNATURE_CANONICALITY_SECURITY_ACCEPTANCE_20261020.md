# S2 Public WSS device/owner signature canonicality audit (2026-10-20)

**Scope:** Isolated source regression on current merged main after PR #537, #546, #568, #585, #594. Does not change WSS TLS negotiation, quotas, Agent/Hub/Broker, artifact store, #596 streams or #551 lifecycle/installer. **PRODUCTION NO-GO**.

## Reproducible source defect

Two independently verified Ed25519 signature entry points accepted a different unpadded base64url string that decoded to the identical 64 bytes:

- verifySignedOwnerPublicWssEnrollment in src/product/owner-public-wss-operator-enrollment-proposal.ts
- ProposedOwnerWssEnrollmentIssuer.issue in src/product/owner-public-wss-device-issuer-proposal.ts

Ed25519 signatures are 64 bytes; unpadded base64url is 86 characters with **four unused final sextet bits**. A final character with altered padding bits can decode to identical bytes and pass the Ed25519 verification. Before the fix, two newly written tests failed with Missing expected rejection; direct physical Work PC source run displayed SAME_BYTES true, DIFFERENT_TEXT true, SIGNATURE_VALIDATION ACCEPTED_NONCANONICAL.

This is textual-signature malleability: it risks nonunique audit/correlation strings, and it violates a canonical wire envelope. **It is NOT an observed ability to forge the private key, bypass a device nonce replay table or exploit production OAuth.** The existing replay key is device+nonce, not signature text.

## Narrow fix

After strict 86-character alphabet validation, decode once and require both:
1. exactly 64 decoded bytes;
2. reencoding those bytes as unpadded base64url equals the original signature text.

Use these validated decoded bytes for Ed25519 signature verification. Malformed device PoP is rejected **before authenticating owner state or consuming a nonce**. Existing canonical signatures, account/device keys, signed fields, nonce uniqueness, session epoch and TLS trust rules remain unchanged.

## Validation and production boundary

- New negative tests check alternative last-character spelling and decoded byte equality for operator receipt and device proof.
- Existing owner/device/forged issuer, key rotation, revoked owner/session/lease, wrong hostname/SNI/SAN/CA/SPKI/rotation, bounded 64 KiB WSS chunks, unknown ACK/reconnect, owner-device-project scoping must remain regression green.
- Source P-256 migration verifier already requires canonical base64url and is unchanged.
- Two physical Windows endpoints previously showed default Software and Platform CNG KSP Ed25519 unsupported (0x80090029), ECDSA_P256 supported (0x00000000). These queries do **not** attest to a long-lived non-exportable TPM key; DPAPI CurrentUser is not equivalent to TPM private-key isolation.
- Existing Agent 1.0.5 tasks, operator OAuth trust authority and Named Cloudflare Tunnel/domain/cert rotation have not been production-verified. No cloud account/token/DNS, Agent restart, key import, service account switch or native Broker authorization is attempted here.
- #596 (actual durable bounded streaming and final hash/CAS) remains separately owned by #08. #551 (signed installer, canary, rollback and restart) remains separately owned by lifecycle team. Exact-head CI success is only source-level acceptance, not proof of 100+ concurrent live authenticated transfers.

**Release decision: Production NO-GO until authenticated operator-controlled Named Tunnel, owner/device/revocation, OS non-exportable key, service account isolation, TLS certificate rotation, signed installer/canary/rollback and physical independent-device acceptance are verified.**
