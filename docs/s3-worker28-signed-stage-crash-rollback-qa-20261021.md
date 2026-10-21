# Worker #28: independent signed-stage recovery failure acceptance

**Date:** 2026-10-21  
**Base (source owner #12):** #672 `84714bb77ec00a8e79ebb732c1070dda1a331975`, CI `39632489293` SUCCESS.  
**Compared independent QA:** #658 `c643222692e5f3130b0fc5f90886b1a2fa0dbff3`, CI `39630933999` SUCCESS.  
**Scope:** *only* `test/fixtures/s3-worker28-signed-stage-crash-idempotence.test.ts` and this document. No #12 implementation edits.

## Distinct acceptance vs #658 and #672

#658 covers partially copied Agent target, wrong publisher on an old Agent 1.0.5 rollback, ACL and stale DPAPI source gates on #632. #672 implements an independently signed protected complete binary/import inventory and an additional *cross-stage* signature ↔ owner Task Scheduler ↔ DPAPI identity binding. This QA exercises those newly introduced #672 functions, not an unrelated in-memory acceptance algorithm.

1. **After signed manifest, before atomic switch:** valid Ed25519 signed inventory and synthetic Publisher verifier yields only `staged_source_checked` with `actuallyInstalled:false`. Local `signed_stage_ready` and `target_cutover_started` recovery records cannot auto-publish, auto-restart or rollback. Changed bytes after manifest still reject. **No real atomic switch or power-cycle occurred.**
2. **Broker offline after owner re-pair:** a signed staged graph with the previous DPAPI key epoch/blob or old owner-task image is rejected by `assessCoreLinkedStageAndDelegation`; UNKNOWN task state also denies source acceptance. Owner minimum epoch advancement fails closed. The test fixture's alleged OS-provided fields are not a verified Windows token or actual DPAPI readback.
3. **Unsigned restore across updater parent ACL:** the `rollback` role must independently pass Authenticode inspection, even when every parent is nominally protected. Separately a writable Authenticated Users updater parent is denied even with a fake valid signature, and the combined failure cannot pass. All ACLs are synthetic SID/ACE records and do not substitute for effective-access proofs.
4. **Idempotent rollback requirement:** repeated identical `rollback_cutover_started` crash journal evaluation deterministically returns `NO_AUTOMATIC_RESTART_OR_ROLLBACK`, not a second mutation. An independent sequence advance rejects old local journal replay, and a fabricated `rolled_back` field rejects. **This validates non-replay behavior, not OS-level exactly-once rollback or durable transaction idempotency.** Actual guarantee needs an external CAS/witness and native postcondition readback.

## Reproduction and proof limits

```bash
npm run typecheck
node --test --import tsx test/fixtures/s3-worker28-signed-stage-crash-idempotence.test.ts
```

The existing `npm test` glob picks up this test under `test/fixtures` without CI modifications. Record the exact PR HEAD, workflow run, failed jobs and test counts; do not rerun the same active SHA.

**Hard NO-GO:** #271 actual legacy ACL issue; first-party Windows-signed installer, Broker/helper/import/updater/rollback artifact and independent publisher/cert pins; complete signed old Agent 1.0.5 rollback package; tested protected parent/updater ACL effective write denial; actual immutable running binary/creation-time HIGH-token attestation; OS-approved enrollment/UAC; offline DPAPI key destruction; external monotonic CAS journal; authorized physical Windows crash/rollback VM acceptance. None were changed, invoked, or claimed. No live installer, UAC, service/Agent, ACL, VM, real DPAPI or ReVoltVPN-Ubuntu-Lab mutation. Keep DRAFT.
