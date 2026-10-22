# NEXOWIRE #06: #725 original 52/53 regression reproduction and orphan UNKNOWN closure
2026-10-22, source-only. No live Agent, VM, ReVoltVPN-Ubuntu-Lab, Artifact Store, UAC, ACL or production data changes.

## Exact SHA and GitHub provenance
- Parent Connection PR #742 exact HEAD `b93ee12a7737085050768261bff9b4fc71019b65`: hosted run `39678274991` **SUCCESS (7/7)**.
- #725 original Artifact owner HEAD `09c3dcaf23103b429780c2862c846956058bdcb8`, hosted run `39659633982` SUCCESS, left untouched.
- This follow-up is a child of #742; only Connection files/test/doc can change.

## Disprove Connection causality for the inherited #725 owner failure
Fresh isolated worktree at #725 **original exact HEAD with zero Connection source/test overlay**. The original `test/artifact-writer-fence-221k.test.ts` and other Artifact files were kept byte-for-byte unchanged, including all assertions.
- `node --test --import tsx test/artifact-writer-fence-221k.test.ts`: **7/7 PASS**.
- `node --test --import tsx test/artifact-writer-fence-221k.test.ts test/artifact-08-owner-receipt-cancel.test.ts test/artifact-588-cross-device.e2e.test.ts`: **10/11 PASS, 1 FAIL**, the *same inherited* `lost ACK after durable first chunk requires explicit resume, never replays first write`. Error: `Fixture terminal state never reached, expected=COMPLETED`.
- `node --test --test-concurrency=1 --import tsx` with the same three test files: **11/11 PASS**.
- The owner test polls status at 12ms intervals for up to 450 iterations, then raises a terminal timeout. The difference is reproducible on unmodified owner source under combined scheduling, while serial mode passes. This supports a scheduling-sensitive Artifact worker/test issue, **not a Connection epoch defect**. It is *not proof* of the ultimate cause of the worker's missing terminal state and does not waive the failed parallel run.
- Do not alter #08's file, fixture, sleeps, polling bound or assertion. #08/#16 to investigate terminal statuses during concurrency and worker owner acceptance separately.

## Actual Connection-only source defect and fix
In `src/mcp/cross-device-worker-journal-link.ts`, an orphaned UNKNOWN outcome could lose both durable `pending` envelopes while retaining forensic `MUTATION_UNKNOWN` and the exact source/worker offset. Previously this would return `prefix_consistent`, implying an ordinary active job despite unresolved Native effects. **Fixed fail-closed**:
- Missing both pending with worker `MUTATION_UNKNOWN`, `RECOVERY_REQUIRED`, `FAILED` or checkpoint `unknown` => `mutation_unknown`, no replay/byte credit.
- `CANCELLED` or `CANCEL_REQUESTED` without pending => `cancel_pending`; worker `PUBLISHING` with no independently verified publish => `unverified_completion`.
- Only `QUEUED` / `RUNNING` with no pending, exact aligned offsets and trusted current grants may return `prefix_consistent`; this **still never authorizes dispatch**.
- Keeps full forensic `errorCode=FORGED_WRITE_RECEIPT`, zero offset, no code path to mutate any filesystem or checkpoint.

New deterministic test cases in `test/connection-725-712-forensic-reconnect.test.ts`:
1. Both `pending` envelopes missing while worker UNKNOWN => never healthy prefix.
2. Explicit status matrix for FAILED, RECOVERY_REQUIRED, PUBLISHING, CANCELLED/CANCEL_REQUESTED and safe QUEUED.
3. Temporary SQLite WAL/FULL journal reopen followed by two authenticated Broker epoch transitions 5→6→7, no replay, no readback invocation, no mutation, zero credited bytes and fresh owner revoke fail-close.

## Accepted scope versus physical gates
Local exact follow-up branch: `npm run typecheck` PASS; `npm run build` PASS; **163/163 targeted regressions PASS** across 25 files including the 3 new Connection negative tests.
#742 still synthetic source: trusted ownerEpoch/grantGeneration nonce readback is an injected witness, not deployed protected Broker, and no #712 side-effecting dispatch claim is allocated by this read-only inspector. Do not claim physical Native Agent v1.0.5 resume, real external CAS or production safety.

Production NO-GO until #08/#01/#05 finish atomic worker intent/receipt, independently authenticated Native data readback, revocation-safe dispatch and physical integration acceptance.
