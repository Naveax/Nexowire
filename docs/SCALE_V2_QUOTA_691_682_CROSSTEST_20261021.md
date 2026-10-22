# Scale v2 Quota #14 | #691 predispatch and #682 late UNKNOWN source compatibility

21 October 2026. SOURCE/STAGING-only child branch based on #687 exact HEAD
0cc9710c37d19d4e31cc2f3ae9fb1984b5ffd1b8, whose Actions run
39644697445 is confirmed SUCCESS. No real CORE, D1, VM, Agent or billing.

## External owner contracts checked

- #691 source HEAD 437030d288fdf13441f506ce83a9ff72644822dd:
  a durable pending Native intent with dispatched=false and no Native
  call may settle CANCELLED; after dispatch (or old journal without
  reliable dispatched flag), uncertainty must remain MUTATION_UNKNOWN.
- #682 source QA HEAD 0dcd05debfeda91882bccc09834d216223c935ca:
  late Native mutation receipt, signed-looking publish receipt, prior
  CORE owner grant, stale CAS or re-pair cannot mint a current mutation
  witness, authorize replay, or validate deletion.
- #08 owner code and #22 QA code are not changed, copied or merged into
  this quota PR. The new fixtures model the same outcomes and negative
  boundaries independently. Passing them does NOT constitute a combined
  real Native writer / external CAS integration acceptance.

## Narrow source change

ServerBoundArtifactCleanup gains mandatory pendingDispatchState:
NEVER_DISPATCHED or DISPATCHED_OR_UNKNOWN. For zero highest-dispatched
writer epoch, only NEVER_DISPATCHED is valid. Any positive dispatched
epoch must be DISPATCHED_OR_UNKNOWN. A missing legacy dispatched state
is denied, not assumed safe. These are trusted server-loaded durable
job/dispatch facts; **never parse them from client-supplied JSON**.

Under a held rollback-independent external writer-fence, the protected
authority must independently read back both persisted
nativeDispatchHighWaterEpoch and pendingDispatchState, and they must
match the server-bound job. A stale or dishonest predispatch claim is
rejected if external dispatch high-water is nonzero. Both cases still
require current protected CORE grant, persisted revocation epoch
strictly greater than dispatched high-water, zero live Native writers,
independently verified physical absence/deletion, and original #610
trusted deletion and writer-fence proof verifier.

### Cancellation / release invariants
- #691 never-dispatched: byte admissions remain zero; disk reservation
  may change once to RELEASED_FIRST only after independently verified
  no-dispatch, stopped writer fence and stage absence. Retried cleanup
  returns RELEASED_ALREADY, not a new refund.
- #682 dispatched/late-UNKNOWN: even with zero ACKed bytes, the Native
  dispatch high-water is positive; pending chunk byte admission stays
  charged, no auto replay, premature cleanup or refund. New Hub or CORE
  revoke/UNKNOWN/stale CAS cannot permit release. Only a verified higher
  revoke epoch + physical deletion may release disk once. Minute bytes
  are never refunded.
- Missing dispatched marker (old journal) MUST remain UNKNOWN; it
  cannot be laundered into NEVER_DISPATCHED or zero-byte clean release.
- Signed-looking client flags or forged receipt object are never
  authoritative. External writer-stop/deletion authority remains
  an interface, not a production implementation. Test synthetic
  authorizations are not cryptographic/physical proofs.

## Acceptance limitations
Local disposable SQLite WAL + synthetic external proof, NOT a real
Cloudflare D1 transaction, protected Windows HIGH Broker, actual
Agent 1.0.5 Native write, installed high-integrity process or physical
1 GiB transfer. Parent PR #687 exact CI PASS does not grant this child
a green status. Keep child DRAFT until exact-head CI and independent
#08/#22 review; no production billing, quota policy or entitlements
changed. Live Free stays 1,000 weighted credits per UTC month; daily
plan proposals remain dormant.

## Independently executed original owner test evidence

- #691 exact HEAD 437030d288fdf13441f506ce83a9ff72644822dd: unchanged test/artifact-588-postjournal-predispatch.qa.test.ts, 1/1 PASS in isolated clean detached worktree.
- #682 exact HEAD 0dcd05debfeda91882bccc09834d216223c935ca: unchanged test/qa22-crosshub-cas-fencing.test.ts, **15/16 PASS, 1 FAIL**. The RED test at line 669, late cancel after lost signed Native publish ACK, returned CANCELLED when expected MUTATION_UNKNOWN. This is a real #08/#22 contract blocker, never skipped or reclassified as successful.

These owners' implementations remain untouched. The quota-specific source suite models separate invariants; it does not cure #682's worker RED or prove integrated D1/Native behavior.

## 22 October follow-up: #725 forged ACK / #708 two-Hub late lease

- Unchanged #725 exact HEAD `09c3dcaf23103b429780c2862c846956058bdcb8`: independently executed owner test `test/artifact-08-owner-receipt-cancel.test.ts` in a clean detached worktree: **3/3 PASS**; exact-head workflow `39659633982` SUCCESS.
- Unchanged #708 exact HEAD `d2eaf951554335a5f4f25ebf9ea3d63c91f38010`: independently executed `test/qa22-crosshub-cas-fencing.test.ts`: **20/21 PASS, 1 FAIL**. Failure at line 897 observed `TRANSFER_CANCEL_AFTER_MUTATION` rather than expected immutable `FORGED_WRITE_RECEIPT`. #708 exact CI `39677524701` FAILURE. Quota worker did not edit, skip or reclassify the red owner/QA assertion.
- Prior cleanup contract checked current owner/device/project/session/root, monotonic revoke and writer-stop epochs and a receipt ID. It did not bind the exact protected Native DISPATCH requestId and SHA-256 to independent deletion readback. Source extension requires `lastDispatchedRequestId` and `lastDispatchedChunkSha256` for positive dispatch high-water, or both NULL only for independently verified `NEVER_DISPATCHED` and zero high-water. Immutable witness, trusted server-held job binding and external readback must agree. Missing request ID/hash, arbitrary forged ACK ID, mismatched SHA, stale Hub lease or receipt ID mismatch FAIL CLOSED.
- Test fixture now provides receipt ID from a separate synthetic protected store, NOT echoed from caller witness; a forged source receipt cannot mint an independent proof. Provider trust and protected signer are still mandatory outside this module. Client Boolean flags are NOT trusted.
- After CORE owner/device re-pair, forged late ACK or `UNKNOWN`, a new release is denied. Once externally attested physical deletion under a held fence releases storage exactly once, repeat releases return `RELEASED_ALREADY` and admitted minute bytes remain charged. Production billing Free=1,000 weighted credits/UTC month unchanged; no D1, live VM or real Native Agent mutation.
- This is independent local SQLite WAL/CAS simulation. Passing quotas cannot replace #08/#22 combined acceptance or actual signer/file-ID/durable store verification; **production remains NO-GO**.
## 22 October NEXT: #725 / #708 unresolved Native mutation admission gate

- Parent #718 at `2dbb6dfb41699f4ecc1ec3852cdd0462fc0308e9` had CI run `39734543164` still IN_PROGRESS at the start of this review (6 of 7 jobs SUCCESS); no green completion claim. #725 exact HEAD `09c3dcaf23103b429780c2862c846956058bdcb8` CI SUCCESS, unchanged owner test 3/3 PASS. #708 exact HEAD `d2eaf951554335a5f4f25ebf9ea3d63c91f38010` CI FAILURE, unchanged QA 20/21 with `test/qa22-crosshub-cas-fencing.test.ts:897` actual `TRANSFER_CANCEL_AFTER_MUTATION` instead of immutable `FORGED_WRITE_RECEIPT`. Do not suppress that failure.
- Security gap: pre-existing #14 admission checked scope, immutable Native requestId/SHA, monotonic writer revocation and stage deletion, but **did not independently reject an unresolved Native mutation status** if the same store was reported deleted. A hub returning CANCELLED or a signed-looking ACK must never turn an unresolved physical effect into a disk quota release.
- Added an independently attested external Native reconciliation state with strict values: `NEVER_DISPATCHED_CLEANUP_VERIFIED` only for zero DISPATCH; `DISPATCHED_CLEANUP_VERIFIED` for positive Native DISPATCH; pending `MUTATION_UNKNOWN_PENDING`, `FORGED_ACK_PENDING`, and `OWNER_REPAIR_PENDING` are NEVER accepted. Both the immutable deletion witness and the current protected external readback must agree, and current `unresolvedNativeMutations` must be exactly zero.
- The independent reconciliation epoch must strictly follow persisted writer-revoke and precede/equal durable physical deletion. The external monotonic lease MUST cover reconciliation, writer quiescence, stage deletion and SQLite quota admission. No client booleans, Hub status, ACK or user JSON may issue a trusted proof.
- Synthetic two-handle quota tests now cover unresolved UNKNOWN after superficially verified deletion, forged ACK provenance still pending, re-pair pending, stale reconciliation epoch and missing/negative pending counts. Quota source behavior denies all pre-reconciliation releases without lowering existing #610 proof checks. After independently verified cleanup, first SQLite disk release returns `RELEASED_FIRST`, repeat `RELEASED_ALREADY`, and transport minute credits are never refunded even across owner re-pair or UNKNOWN. These are NOT payment refunds.
- These contracts are NOT a deployed physical Native signer, rollback-external CAS or real Cloudflare D1. #08/#22 must provide protected trusted current readback and fix the red source QA; no #08 owner source, real files, Agent/VM, live D1, billing or entitlements changed. Production Free is still 1,000 weighted credits per UTC month; daily paid proposals stay OFF. Keep DRAFT and production NO-GO.