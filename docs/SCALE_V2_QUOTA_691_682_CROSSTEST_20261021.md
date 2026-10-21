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
