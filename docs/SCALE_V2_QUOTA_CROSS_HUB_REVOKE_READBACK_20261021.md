# Scale v2 Quota #14 | Cross-Hub revoke epoch + independent cleanup readback

21 October 2026. Isolated source-only child of DRAFT PR #668, exact parent 72a4f923d92c1830afa8947852d1557194540b5a.

## Change scope
- Own quota files only: src/ops/scale-v2-artifact-fenced-cleanup-admission.ts,
  src/ops/scale-v2-artifact-byte-budget-staging.ts, and own quota tests.
- No modifications to #634 / #08 Artifact store, transfer worker, native writer,
  #640 / QA #21, VM, elevated CORE/UAC, live D1, Cloudflare, user files,
  payment, invoices, billing, or production entitlements.
- This is a **staging contract**. A trusted implementation of the external
  authority is NOT included or implied, and cannot be manufactured from user JSON.

## Independent rollback-safe evidence
The adapter's TrustedFencedDeletionAuthority must:
1. Hold an externally authoritative, cross-Hub, rollback-independent writer
   fence throughout the nested CORE-grant verification and quota ledger update.
2. Re-read the CURRENT external CAS state while holding the fence. A cached
   receipt, local SQLite row, process ID, client boolean, optimistic ACK or
   worker state is not an independent readback.
3. Confirm matching authenticated owner/device/project/session/root and
   unchanged owner/device grant epochs.
4. Confirm a persisted writer REVOKE epoch **strictly greater** than the
   highest DISPATCHED native writer epoch, including acknowledged and
   ACK-UNKNOWN writes. It must precede verified physical deletion and be
   covered by the held fencing epoch.
5. Match the original immutable receipt's stopped-through, deletion epoch,
   fence epoch and receipt ID to independently read-back values, with zero
   in-flight native writers and VERIFIED_ABSENT physical content.
6. Recheck CURRENT signed/protected high-integrity CORE grant while the writer
   fence is held. Revoke, re-pair, stale epoch or UNKNOWN always denies.
7. Pass the existing #610 trusted durable deletion and writer-fence verifier;
   client-provided writersStoppedVerified/durableDeletionVerified/commit booleans
   alone never mint trusted proof.

The adapter fails closed if readback is unavailable or forged, if any Hub
holds a newer fencing epoch, if the writer-revoke epoch is absent/too old or if
the producer has not stopped. **There is no direct actual Agent/store hookup.**
The protected server-side implementation must guarantee the lease duration and
trustworthiness of all readback values; a forged provider returning plausible
objects is not solved by structural checks.

## No duplicate refund
A new staging-only acknowledgeDeletionOnce is transactional under SQLite
BEGIN IMMEDIATE and returns RELEASED_FIRST on the first mutation or
RELEASED_ALREADY for any replay. The old acknowledgeDeletion remains
backwards-compatible and returns RELEASED in both cases for existing callers.
Only FIRST is eligible to be counted as a single *disk-reservation release*,
never as a payment refund. The sliding rolling-minute admitted byte counter is
NOT reversed in either case, including cancellation, transport reconnect,
revoked CORE, crossing UTC boundary, unknown ACK or another Hub retry.

These independent tests use disposable SQLite WAL and a deliberately
synthetic externally held CAS/physical disk proof fixture. Passing tests
cannot prove that an external witness is non-restorable or that #634 native
writer/reader actually matches the contract in production.

## Status
- Parent #668 exact-head CI run 39632010226: overall **FAILURE**,
  Node 22/24 and all jobs except unchanged Windows browser-live SUCCESS.
  Browser-live failed physical Windows Job Object regressions.
- #616+#610 combined original synthetic acceptance: 4 PASS / 1 FAIL,
  TRUSTED_DELETION_EVIDENCE_REQUIRED. This was correctly fail-closed.
- #640 independent prior source acceptance at head
  91f1426f5378bc2eaf3a680a7f7e067f8d4eba73: 3 PASS / 2 FAIL
  (read-only cancellation became UNKNOWN, and later cancel incorrectly
  changed UNKNOWN to CANCELLED). Not altered in this quota PR.
- Cloudflare D1 staging acceptance is BLOCKED, absent owner-approved isolated
  staging account/database/token/Worker, NO live cloud calls.
- Physical #596/#616/#634/Agent/VM and actual production CORE: NOT TESTED.
- Live Free stays 1,000 weighted credits per UTC month, verified owner
  exception preserved; daily Free/Plus/Pro proposals dormant. Billing OFF.

Keep this child DRAFT until independent #08 store/proof and #21 QA review.
