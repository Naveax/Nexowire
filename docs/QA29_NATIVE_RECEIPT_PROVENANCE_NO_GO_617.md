# P0 #29: signed OS creation FILETIME and independent postcondition receipt QA

**Status:** Test-only stacked acceptance; not physical elevation, installed-agent evidence, Windows native attestation, or deployed external CAS. Parent [PR #662](https://github.com/Naveax/Nexowire/pull/662), verified source HEAD `5b2047d6a0e0caf880800f13a36e2432d98c90d6` with both previous workflows SUCCESS. This new branch modifies ONLY test/docs/isolated CI files. The #03 ProcessManager, #01 external CAS, #04 grants, installed Agent/Broker/UAC, ACL, service and VM are unchanged.

## Exact receipt trust boundaries

1. **Owner-intent & reservation:** tuple `requestId + ownerId + deviceId + sessionId + ownerEpoch + coreEpoch + intentHash + targetId + targetGeneration + expectedStateHash`. A separately obtained *current* authority receipt must match this tuple, carry the reserved `reservationNonce`, and assert one dispatch. This model's Ed25519 signer is a disposable fixture, NOT an external monotonic authority or OS approval.
2. **OS-native process evidence:** separately signed `os-process-created-v1` binds request, device, owner, session, epochs, intent, reservation, PID, **Windows creation FILETIME**, machine boot ID, launch nonce and creation time. It also contains purported High/System integrity, enabled Administrators, pinned publisher + image hashes and protected ACL. Those fields are **claims in a synthetic test**; production must measure and protect them independently, not accept self-attested JSON from Hub or Broker.
3. **OS exit + captured streams:** a signed `os-exit-v1` binds the *same* boot, PID, FILETIME, nonce and reservation. It carries exitCode, monotonic-compatible exit timestamp, complete output commitment flags and only digests (no raw stdout/stderr). HTTP 200, ACK, stdout text `SUCCESS`, or `exitCode=0` never prove an actual target mutation.
4. **Independent readback:** a distinct fixture observer key signs `independent-postcondition-v1`, matching the exact process and original target/generation/owner/epoch/intent/reservation and **observing after exit**. Success needs the observed state digest to match the owner-authorized expected digest. Authenticated mismatch or nonzero exit is `FAILED_VERIFIED`; missing, forged, incompatible or out-of-window evidence is `MUTATION_UNKNOWN`.
5. **Tamper-evident rotating audit:** strict event schema, per-event hashes, per-segment **Ed25519 signed seals**, previous-seal linkage and fresh independent latest root. The independent authority's current audit seq+head must match the externally returned root. The actual three signed process/readback receipts must match the audit event commitments, not just arbitrary signed content.
6. **Revocation / crash:** late/duplicate ACK after a simulated Hub crash cannot dispatch again or substitute for readback. Updated current CORE owner epoch (or owner re-pair) rejects the old signed receipt for *current authorization*. It **does not establish that a previously launched process was terminated or its OS effect rolled back**. Every verifier result sets `retrySafe:false`, including after UNKNOWN.

## Confidentiality / redaction

`redactAudit` is a strict, fixed-schema projection, preserving only event kind, UUID requestId, owner/core epochs and an already opaque evidence commitment. It never forwards caller-provided password, token, authorization header, raw stdout, stderr, command, arguments, or nested metadata into the audit projection. A hash of a low-entropy secret is not safe redaction; production must use secret-free, keyed/access-controlled commitments and an explicit secure retention/deletion policy.

## Synthetic acceptance tests

`test/qa29-native-receipt-verifier.test.ts` covers:
- forged-success stdout and code 0 with no independently authenticated postcondition
- foreign signing key, injected approval flag, altered or unlogged signed proof
- authenticated mismatched postcondition and nonzero exit as verified failures
- PID reuse / creation FILETIME / machine boot / launch / reservation nonce changes
- claimed medium Windows integrity, deny-only Administrators, replaced image/publisher and unprotected ACL
- owner/device/session/CORE epoch/immutable target/generation/intent cross-binding, freshness and exit ordering
- two-Hub duplicate ACK, missing authority and revoke/re-pair
- missing/reordered/truncated/tampered rotation segments, stale signed root and co-rollback witness mismatch
- exact audit projection secret stripping

### Reproduce

```sh
npm ci
npm run typecheck
node --test --import tsx test/qa29-elevated-command-audit-provenance.test.ts test/qa29-rotated-audit-crosshub-negative.test.ts test/qa29-native-receipt-verifier.test.ts
```

Dedicated CI file `.github/workflows/qa29-native-receipt-verifier.yml` runs Node 22/24 **source-only**. Check exact PR head, both jobs and the repository's ordinary CI before reporting PASS. No CI shortcut, skip or old green SHA reuse.

## Production NO-GO

Test-generated Ed25519 keys and an in-memory authority/ACK dedupe set are explicitly non-durable. Independent native Windows kernel identity, protected OS signer, actual process creation FILETIME attestation, postcondition witness trust, production signed Broker installer/runtime ACL, external monotonic authority and physical authorized Windows acceptance remain **unverified**. ReVoltVPN-Ubuntu-Lab is prohibited from testing. Keep DRAFT; do not enable elevated dispatch or merge main as proof.
