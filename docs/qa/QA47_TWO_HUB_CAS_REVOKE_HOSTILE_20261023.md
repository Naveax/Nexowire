# QA #47: Two-Hub CAS/revoke hostile contract (2026-10-23)

## Evidence
- Scope: NEW QA test, disposable OS TEMP only. No native writes, real Hub, Agent, D1, UAC, VM or user files.
- QA base: #807 exact HEAD 1e84d87c98c91b2d6e97a47de610ffe353d199df, itself based on #797. Artifact production and previous QA owner files remain unchanged.
- #708 HEAD 36b443ef300d6465fa11af3a02c94b394d8841a1, Actions 39824007092 FAILURE at Node 22: checkpoint save proceeds after Hub B ownerEpoch revoke 7 -> 8. This independent RED must remain unchanged.
- #807 introduces the protected callback saveIfCurrent but no external provider. Actions 39841880930 test(22)/test(24) SUCCESS; browser-live Windows Job Object FAILURE. Source-green is not physical CAS proof.
- #18/#781 HEAD 89a865363829c8c30a74de1516e53a697549c05b, Actions 39816363122 SUCCESS: reproduces cloned UNKNOWN runbook redispatch. Negative reproduction, not anti-replay.
- #21/#776 HEAD b3b26c497263cbee22214b48c161c21d29328766, Actions 39841495779 FAILURE; preserve #762 issuer/revoke negatives.
- #35 pairing writer commitPairing/readCurrentPairing/claimEnrollment has no established trusted two-Hub external authority. #720 WSS pairing REPLACE/DELETE revision control is not proof of atomic ownerEpoch/grantGeneration/issuerEpoch publication admission.
- #587 joint journal+authority rollback re-admitted historical reservation. In-memory model, local mutex, fsynced file and copied signed receipt are not an independent monotonic trust root.

## Deterministic negative matrix

| Scenario | Observable expected result | Classification |
|---|---|---|
| Missing off-host protected save admission | Adapter rejects, no durable checkpoint | Source fail-closed |
| Hub B revoke-start after A readbacks and before admission | A denies before write | MODEL-ONLY race schedule |
| A admitted write before B revoke-start | Write finishes before simulated revoke linearization; old owner cannot read | MODEL-ONLY order |
| Cloned UNKNOWN alias with borrowed request/commit | Rejected by original jobId binding | Source + simulated ledger |
| Grant generation changes without ownerEpoch changing | Old grant denied | MODEL-ONLY requirement |
| Lost save ACK after successful local checkpoint write | API returns error; raw row may exist; UNKNOWN not verified/replayed | Source visibility negative |
| Fake callback provider returns result without calling save | Adapter rejects, no write | Source fail-closed |
| Immutable logical mutation in actual transfer API | TransferJob and TrustedPublicationCommit do not expose logicalMutationId, ownerEpoch, or grantGeneration | CONFIRMED CONTRACT GAP, NOT safety PASS |

All schedules use Promise barriers, no timing sleeps. The authority is one in-process test model, NOT rollback-independent external CAS. Passing source tests validate test wiring only.

## External GO requirements
1. External atomic record and signed Native receipt must bind account, owner, source/target device, immutable task/worktree ID, logicalMutationId, requestId, jobId, source SHA, ownerEpoch, grantGeneration, pairingEpoch, issuerEpoch, signer identity and publication commit. Reject renamed session/runbook aliases; UNKNOWN must never reserve again.
2. Two independent Hubs must linearize revoke-start against actual checkpoint durable fsync/rename publication. Failed or lost ACK after effect is UNKNOWN and cannot authorize retry.
3. A physically independent monotonic trust domain, co-rollback proof, trusted provider signer, native stop/readback, and complete physical two-Hub race tests are mandatory before release.
4. Preserve #708, #762/#776 negative fixtures unchanged. Never infer production success from model assertions, source CI, a local lock or Hub-side Job membership.

**Production authority / physical two-Hub CAS: BLOCKED. Release verdict: NO_GO.**
