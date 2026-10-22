# NEXOWIRE #06: one-call worker ↔ Connection journal source acceptance

Date: 2026-10-21. **Source-only. Production BLOCKED.**

## Exact provenance and CI discrepancy

- GitHub verified PR #613 actual HEAD: `b3e3b7bcd6e73a52c0974fe792898d59c2c269cd`, workflow `39608452356` **SUCCESS**.
- Requested alternative SHA `b3e3b7bcd6e738ed2301f0e83d32fe51f804df1d` does **not exist in GitHub** (commit lookup 422 No commit found, workflow lookup empty). Do **not** label this a failing CI run or rewrite an unrelated branch to generate green.
- #605 is MERGED; #613 remains OPEN/DRAFT. #616 exact HEAD `94b92e01219aca3cd4ca86775fe4b61a72ac53c4` CI SUCCESS but DRAFT.
- #634 exact HEAD `9266f9b65a1f193360469223360552a50892949a` is a DRAFT child of #616. Exact run `39610829832` **FAILURE**: original `test/artifact-588-cross-device.e2e.test.ts:259` cancel/publication race. Separate independent worker QA #640 reproduces further real cancellation state bugs. This new Connection test does **not** skip, patch or resolve #08's red tests.

## Added Connection-owned adapter

`src/mcp/cross-device-worker-journal-link.ts` introduces a **read-only**
`inspectOneCallWorkerConnectionJournal()` and structural
`FencedWorkerJournalSnapshot` compatible with #634's persisted job JSON.

**Inputs must be trusted:**
- #08 durable worker snapshot: ID, owner/account, project, exact source/target
  devices and paths, generated stage path, total size, SHA-256, confirmed
  offset, pending UUID + exact chunk offset/length/hash + worker epoch.
- #613 Connection `TransferCheckpoint` from revision-CAS store, with
  its own WSS connection epoch and outstanding mutation request UUID.
- Authenticated Broker `AuthenticatedTransferRoute` (never from
  response JSON) with owner, project and exact device IDs.
- Independent current `TransferAuthorization` (CORE/ROOT owner grant),
  and `WorkerLeaseWitness.check()` backed by #616/#634's independent
  monotonic CAS, not simulated PID/file locks.
- Optional `TrustedStageReadback` of **actual** destination stage bytes,
  not a copied write ACK or fake receipt.

**Fail closed** on wrong owner/project/device/path/hash/size,
stale WSS epoch, mismatched requestId, wrong chunk offset/digest,
different worker lease epoch, unavailable/revoked grants,
source-stage corruption and cancelled/UNKNOWN side effects.
After awaited readback, re-check both the independent owner grant and
worker lease, so a revoke during the read cannot credit evidence.

**Three epochs are not interchangeable:** worker monotonic lease epoch,
WSS route/connection epoch and owner/CORE or ROOT session grant epoch.
#634's `worker.pending.epoch` must match the **worker** lease epoch,
not the WSS epoch; the same requestId and immutable chunk identity
bridge the two journals.

A correct readback returns only `readback_verified_not_committed`.
It **never** writes to a store, never advances the journal, never
calls `reserveWrite`, never retries a mutation, never makes a side-effect
claim and never certifies a final publication. To move the prefix,
#08 must coordinate one authoritative committed receipt with the #613
CAS update under current grants; no competing local SQLite roots.

An orphan `pending` cannot turn into `CANCELLED` on a lost ACK:
`cancel_pending` and no re-dispatch/unsafe deletion. Even a
`COMPLETED` worker state without independent final published SHA,
target device and size verification is `unverified_completion`.

## Tests and reproduction

`test/cross-device-worker-journal-link.test.ts`: ten isolated negatives.

1. Lost ACK + exact requestId readback is observed but uncommitted.
2. CORE revoke while readback is in progress blocks acceptance.
3. Independent worker lease highwater advance mid-readback blocks acceptance.
4. Wrong source/target/project, stale WSS, forged requestId/chunk hash,
   stale worker envelope epoch all denied.
5. Partial, foreign-device and corrupt chunk readback keep UNKNOWN.
6. #634 CANCELLED metadata with a pending mutation remains cancel_pending.
7. Checkpoint offset / worker confirmed offset mismatch; fake COMPLETED
   never proves independent publication.
8. ROOT grant/session-generation revoke independent of worker/WSS epochs.
9. Missing grant or worker CAS authority blocks all trust.
10. Disposable SQLite WAL/FULL snapshots reopened after simulated crash:
    readback correct only as observation; on-disk bytes corrupted after
    reopen yield UNKNOWN; zero checkpoint commits or mutation replay.

Run on source branch with Node dependencies:

```powershell
npm run typecheck
npm run build
node --test --import tsx test/cross-device-worker-journal-link.test.ts
node --test --import tsx test/cross-device-transfer-owner-grant.test.ts test/cross-device-transfer-continuity.test.ts
```

Compare against #634 only with a **disposable worktree overlay** of the
Connection-owned files. Keep #634 `src/mcp/cross-device-transfer-jobs.ts`,
`src/workspace/artifact-bridge.ts` and all owner QA tests unchanged.
Original inherited #634 red cancel/read behavior remains a real blocker.

## Production NO-GO and owner handoff

1. #08 must inject an actual external monotonic worker lease witness
   and publish an independently verified destination stage readback
   under authenticated device/owner/session scope.
2. #613 and #634 currently have **separate persistence authorities**;
   no combined transaction assures atomic worker receipt + connection CAS.
   Do not claim durable one-call resume from this read-only shim.
3. #08 worker cancel should not downgrade dispatched UNKNOWN to CANCELLED.
   Existing deterministic red child test suites #640/#651 and owner
   `test/artifact-588-cross-device.e2e.test.ts:259` must be fixed
   without skipping them. Pre-dispatch canceled operations without any
   remote side effect should be CANCELLED, not UNKNOWN.
4. Current physical Agent v1.0.5 does not implement signed Native fenced
   write/cancel/real offset CAS; no production rollout or physical transfer
   acceptance. #617 signed Broker CORE, #587 rollback witness and #05
   verified Native writer remain independent release gates.

No physical Agent transfer/restart, no UAC, no VM, no store implementation
changes and no user's files opened or mutated.

## Executed acceptance numbers on 2026-10-21

- Own child branch based on #613 exact commit b3e3b7bcd6e73a52c0974fe792898d59c2c269cd: typecheck PASS; build PASS; 142/142 in 23 targeted modules PASS, including 10 new worker↔journal link tests.
- Disposable compatibility worktree at #634 exact commit 9266f9b65a1f193360469223360552a50892949a, overlaying only Connection-owned sources/tests: typecheck PASS; build PASS; 47/47 in six targeted modules PASS; no #08 changes published.
- Original #634 artifact-588-cross-device.e2e.test.ts isolated local rerun 1/1 PASS, **but** its hosted exact-head CI 39610829832 was FAILURE at the same cancel assertion, and #640/#651 independently expose additional cancel/UNKNOWN defects. Flaky/racy original test is NOT fixed by an isolated passing run.
- No physical Agent/VM/production transfer was tested. Real external monotonic CAS and signed Native v1.0.5 writer remain BLOCKED.
