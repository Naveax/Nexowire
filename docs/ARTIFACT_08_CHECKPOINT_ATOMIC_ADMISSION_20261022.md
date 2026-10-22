# Nexowire #08 P0: checkpoint revoke-start atomic admission contract
Date: 2026-10-22. Source-only DRAFT child of #797 exact HEAD 9e75943adc869528839a99339e1852cc15693f66 (GitHub Actions 39823465809 SUCCESS). No protected production CAS service is deployed by this change.

## Exact cross-owner independent evidence

- #708 current head 36b443ef300d6465fa11af3a02c94b394d8841a1, hosted Actions 39824007092 FAILURE: Node22 one genuine adversarial #22/#785 two-Hub checkpoint case RED, Node24 cancelled, all other jobs PASS.
- Original test/qa22-crosshub-cas-fencing.test.ts copied **byte-for-byte** Git blob cecbee461a537993c7700b85b1200d919c1889a4 into a separate #797 isolated worktree. Baseline #797 source: 27/28 PASS, one RED at line 1560: Hub A had passed both independent readbacks, entered ArtifactBridge.saveCheckpoint, paused before durable write; Hub B advanced protected ownerEpoch from 7 to 8. Hub A did not reject and could persist a checkpoint despite revoked epoch.
- #799 HEAD 7e3d1df52a0d3f55350030622a929b7c3fbe78e3, hosted Actions 39823529140 FAILURE solely Windows Job fast-exit stdout not drained, iteration 10 of test/windows-job-owner.test.ts:216. Node22 and Node24 SOURCE SUCCESS; no #08 acceptance inferred from Windows failure and no Windows files changed.
- #762/#776 genuine original negatives (missing independently authenticated commitPublished fixture or post-effect UNKNOWN) must remain RED until their own QA owners establish strict synthetic CAS; never label a possible native side effect CANCELLED or change their expectations.

## Root cause and contract

VerifiedTransferCheckpointAdapter.persist() performed independent publication CAS inspect and CORE assertCurrent twice, including just before store.saveCheckpoint. These checks were NOT atomic with ArtifactBridgeStore.saveCheckpoint's process-local lock, JSON fsync, and rename. An external revoke-start can win after the last check and before durable mutation. A third readback or local mutex is NOT a solution.

The existing TrustedCheckpointPublicationReadback interface provided only inspect(job), not an operation that serializes the independent owner/grant epoch and cross-Hub revoke-start with the actual durable checkpoint write. The #587 external authority and installed Native Agent v1.0.5 do NOT provide a production implementation. This is a **BLOCKED physical contract**, not a completed production repair.

## Smallest fail-closed owner code change

- Add OPTIONAL trusted off-host provider method saveIfCurrent(job, writeCallback) to TrustedCheckpointPublicationReadback. A genuine provider must hold a rollback-independent monotonic current ownerEpoch/grantGeneration/lease admission across the ENTIRE awaited checkpoint save, including fsync/rename; a racing revoke-start must serialize before or after the durable write, not inside the protected interval. The provider must reject if revoke-start has already won. No user/MCP-supplied bool, local in-memory lock or second check satisfies this.
- Adapter.persist() now refuses to call store.saveCheckpoint unless this method is configured: JOB_CHECKPOINT_ATOMIC_ADMISSION_REQUIRED. The existing manifest producer UUID, SHA, scope and external publication requestId/epoch/durableCommitId checks remain unchanged.
- Adapter gives the protected provider one awaited save callback and only returns an actual checkpoint object produced by that callback. It rejects provider that does not perform the callback or returns a different object. The source can enforce fail-closed admission and result provenance; it CANNOT guarantee a provider's off-host atomic implementation. Until an independently authenticated provider is available, checkpoint admission stays blocked on production.
- A source test with readback-only, no atomic provider confirms zero checkpoint writes. Existing legitimate positive fixture uses an explicitly TEST-ONLY synthetic protected provider, not a real external CAS. Another deterministic fixture pauses the protected synthetic admission, advances ownerEpoch, and proves no save callback is invoked, no checkpoint persisted, and CORE_GRANT_EPOCH_STALE propagates.

## Verification and unmodified independent RED

- Local selected Artifact Bridge/worker/CORE/quota/checkpoint and two-sandbox-agent MCP E2E **102/102 PASS**, typecheck/build/continuation PASS, staged whitespace check PASS.
- #708's unmodified fixture has inspect but NO saveIfCurrent. Therefore its existing full scenario remains **NOT green**: it cannot demonstrate real revocation-serialized save until the independent test provider and production trust root are supplied. Do not weaken the contract or change #708 assertions here.
- #799 Node source PASS and Windows Job failure are separate. No source change to Windows Job, #708/#799, #762/#776 or runbooks.

## Production release gate

**Physical #588 NO-GO**: independent rollback-resistant #587 owner/grant/epoch CAS plus checkpoint save admission and protected Native signed publisher #05 are not deployed; #610/#718 independently verified writer-stop, deletion and quota release, #613/#770 owner/session epochs, #16 physical staging and #00 integration still missing. Do NOT claim signed receipt or local COMPLETED as quota refund. No live Agent/Hub/VM, 1GiB file, user-file edits, production merge or deploy.
