# S2 independent owner/device enrollment security regression

Date: 2026-10-21. Source baseline: Naveax/Nexowire origin/main 37d68d938b9c94b8647b92fb592a2b30c075427c.
**STAGING SECURITY PATCH ONLY / PRODUCTION NO-GO.**
Prior #537/#546/#568/#585/#594/#603 merged; no rewrite of signed device PoP serializer, TLS engine, lease/revocation authority or #596 artifact store.

## Reproduced missing negative proof on unchanged main

ProposedOwnerWssEnrollmentIssuer.issue serialized signed device PoP bytes before awaiting async token authentication, then re-read caller-owned mutable request.deviceId and request.nonce afterwards.

Two new tests were written FIRST. On pristine main they BOTH FAILED:
- In-flight authenticated request signed for device-enrolled-001 was mutated to device-enrolled-002. With two synthetic devices sharing a copied Ed25519 public key and the same owner, old issuer returned an operator-signed receipt for device-enrolled-002 although signed bytes bound device-enrolled-001.
- An in-flight signed request's nonce changed after proof bytes were computed. Issuer consumed the alternate nonce rather than originally signed nonce, giving a mismatched replay record.

This is a **staging, in-process asynchronous mutable-input trust boundary / TOCTOU**. It does NOT establish that network callers can mutate already-deserialized requests in the deployed server, forge keys or exploit real OAuth.

## Narrow source fix and tests

At the entry to issue(), snapshot five primitive fields before first await: bearerToken, deviceId, nonce, signedAtMs, deviceSignature. Use pinned values for PoP bytes, canonical signature checks, async authentication, owner/device/key lookup, nonce consumption and signed receipt. No format/algorithm changes.

Two new adversarial tests plus another negative covering owner disable, session epoch change, device key revoke/rotation DURING awaited authentication. No revoked request may consume a nonce.

## #596 streaming receipt trust review: no overlapping edits

At #596 DRAFT code review, durable bytesConfirmed, accountId, projectId, source/target devices and SHA-256 come from Hub-local schema-validated JSON job metadata. Explicit resume compares source full hash, target staging stat, source prefix and target staged hash before proceeding. Chunks are 65,536 bytes, and #596 refuses >256 MiB physical transfer until Agent hash/offset #05 rollout. Positive fail-closed boundaries.

Remaining concerns:
- Hub-local JSON offset/receipt is NOT independently signed external monotonic authority or physical TPM attestation. Hub-local ACL, rollback, owner grant epoch, crash/reconnect need independent verification.
- #596 status() and cancel() enforce caller account and source/target device, but not mandatory projectId. Project is stored and checked at resume. Owner must decide whether same-account cross-project status/cancel access is policy-allowed or requires project-specific gates and negatives; do not claim independent same-owner project isolation.
- Source/loopback CI success does not prove live Named Tunnel, real 1GiB disk, 100+ authenticated WSS, or signed Agent rollout.

## Physical and production limits

Prior two Windows Microsoft Software/Platform CNG queries reported ED25519 unsupported (0x80090029) and ECDSA_P256 supported. DPAPI CurrentUser is not TPM non-exportable private key protection. Real service-account identity, TPM key reopen after restart, owner OAuth, independently signed device enrollment, operator-owned Named Cloudflare Tunnel/account/hostname, TLS certificate rotation and Native Broker in-flight revoke are UNVERIFIED. #596 remains #08 scope; #551 installer/canary remains lifecycle scope.

NO production account/DNS/token/certificate/Agent service/real enrollment changes. This PR remains DRAFT pending exact-head CI, independent review and physical acceptance. PRODUCTION NO-GO.
