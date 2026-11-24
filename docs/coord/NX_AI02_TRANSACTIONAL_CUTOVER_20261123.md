# NX AI-02 | Windows SYSTEM Hub transactional state cutover

**Scope:** SQLite/WAL, source/destination storage headroom, ambiguous journal commit and rollback admission.
**Parent candidate:** `83c8b651106ecd1244fb9d982cf94fd390c15b6b`, Draft PR #1160.
**Owner branch:** `agent/nx-02-transactional-cutover-20261123`.
**Authority:** source/test changes only. The physical Work-PC is exclusively assigned to AI-09; no production actions were run by AI-02.

## Source changes and boundaries

1. `runRecoverableSystemHubCutover` no longer calls automatic `rollback()` when `commit()` throws. Publication of `AWAITING_PHYSICAL_ACCEPTANCE` can be durable even if its call fails. Treat this as **UNKNOWN**, preserve the independent recovery task and require operator reconciliation. Earlier failures still request the independently guarded recovery script, and its own failure remains explicit. `SystemCutoverFailed.outcomeUnknown` and `_COMMIT_OUTCOME_UNKNOWN` explicitly distinguish this from `_RECOVERY_UNVERIFIED` (failure while initially arming recovery).
2. `assertProtectedTargetDiskBudget` checks the authoritative launcher source volume as well as owner profile and protected destination headroom, then probes `SYSTEM_STATE_ROOT` on its actual filesystem; the floor is **ceil(4.1 GiB)** plus twice the receipt's durable bytes. This happens before and after full source/target digests.
3. The offline staging budget now uses the same **ceil(4.1 GiB)** base plus two full state trees. It probes the source/profile/ProgramData volumes independently and the protected stage parent. An **8 GiB advisory** remains separate from the hard minimum.
4. The legacy launcher path, port and SHA-256 are pinned in the private recovery journal. The current launcher and the independent original-launcher backup must both match before rollback. Re-read before quiesce/copy/receipt and **after SYSTEM shutdown before unregister**, with a guarded SYSTEM restart if late drift is detected.
5. The recovery task rejects unrecognized journal phases and rechecks scheduled task name/path, SYSTEM principal, marker, PowerShell binary and exact arguments before any automatic SYSTEM restart. A swapped task action cannot be resumed.
6. These changes are source-level guards. End-to-end Windows physical acceptance, alternate system-drive layout, actual `SQLITE_FULL`, native `READONLY`, reboot and failure recovery remain separate acceptance gates; no green CI result is used as a substitute.

**Never interpret a successful SHA pair, SQLite `quick_check`, `HTTP 200`, a running task, or a green Linux test as Windows SYSTEM physical acceptance.** WAL and main SQLite are durable digest inputs. SHM is a rebuildable cache and is not treated as a durable receipt hash; its file identity, admissibility and stability still require verification.

## Source and fault-injection matrix

| Scenario | Expected decision | Source regression / physical state |
| --- | --- | --- |
| Preflight fails | No quiesce, no rollback | Existing `test/system-hub-controlled-cutover.test.ts`; source test |
| Recovery arm or recheck fails | No legacy stop and no invocation of untrusted recovery | Existing orchestrator tests; source test |
| Copy/receipt/install/verify fails | Exactly one request to independent rollback, whose own state equality check may deny | Existing orchestrator and protected-copy tests; source test only |
| Commit journal write/fsync/readback is UNKNOWN | **No automatic rollback**; preserve independent task and both state trees | New orchestrator fault-injection regression; source test |
| Rollback interrupted | Report rollback failure; retain evidence, do not claim restored | Existing orchestrator regression; real Windows NOT_RUN |
| Recovery script missing, inaccessible, directory or multiply linked | Fail rollback explicitly; never report recovery without artifact and durable journal evidence | Cross-platform disposable-file regression; physical NOT_RUN |
| PowerShell 5.1 UTF-8 BOM journal or foreign terminal receipt | Decode valid UTF-8 with optional BOM, require exact terminal phase and all original transaction identity fields | Portable byte/transaction regression; Windows execution NOT_RUN |
| Manual rollback exceeds 45-second readback deadline | Use the existing scheduled recovery 300-second budget for manual recovery; ordinary readback remains bounded at 45 seconds; timeout still fails closed | Portable source contract; real Windows timed recovery NOT_RUN |
| Recovery journal unknown or incorrectly cased terminal phase | Case-sensitive canonical allowlist before the existing AI-07 terminal exit; reject before task change and do not infer `COMPLETE` | Discovered source test + isolated Windows fixture; physical NOT_RUN |
| Lossy launcher UTF-8 or byte drift | Reject lossy decode; hash exact original bytes to agree with PowerShell Get-FileHash | Cross-platform byte proof regression; physical NOT_RUN |
| Launcher SHA or source/port changes at quiesce/copy/receipt | Reject; retain journal and original launcher backup | Discovered source-contract test; physical NOT_RUN |
| Launcher replaced after SYSTEM stop | Recheck before unregister; attempt resume of exact trusted SYSTEM task | Isolated Windows failure injection + discovered source contract; OS result NOT_RUN unless separately executed |
| Detached SYSTEM writer commits after task unregister | Recheck both durable trees immediately after unregister and again before legacy startup; refuse stale fallback | Disposable PowerShell failure injection + source contract; hosted Windows execution NOT_RUN unless independently evidenced |
| SYSTEM task action replaced before resume | Never execute untrusted action; report `RESUME_FAILED` | Isolated Windows test fixture + discovered contract; OS result NOT_RUN unless separately executed |
| Target/source mount below 4.1 GiB | Deny even when `C:\` is healthy | Disk-reserve tests + new source gates; physical NOT_RUN |
| Reserve declines after successful preflight | Recheck all three mount paths before quiesce/receipt; no early legacy stop, guarded rollback request after quiesce | Six synthetic boundary/path cases inside two portable tests; local PASS |
| 8 GiB advisory not met while floor is met | Report recommendation as unmet, no fake physical PASS | Existing `test/ai04/system-cutover-disk-reserve.test.ts`; physical NOT_RUN |
| Source changes during copy | Reject, preserve partial stage without auto-delete | Existing protected offline-copy test; physical NOT_RUN |
| WAL checkpoint / committed WAL drift | Receipt/main+WAL digest must change or SQLite integrity must reject; do not checkpoint active DB | Existing receipt and integrity tests; crash-injection VM NOT_RUN |
| Dual writer, port ownership change, PID reuse | Deny or hold as UNKNOWN until independent OS owner/re-incarnation evidence | Code review; full Windows negative harness NOT_RUN |
| SQLITE_FULL / SQLITE_READONLY after staging | No deletion/VACUUM/checkpoint on production DB; preserve both trees and journal | Native SQLite engine errors (13/8) in disposable DBs with simulated orchestration: local Node 22.16.0 4/4 PASS, exact tested source blob `40f8d9b85078df26445d937e4a7fc7d0a10dfc57`; Windows filesystem/real cutover NOT_RUN |
| Crash after copy / recovery after reboot | Read journal phase and all durable hashes, deny replay or stale restore | Actual disposable child SIGKILL after file/evidence fsync, unchanged DB digests and no receipt: local PASS; simulated orchestrator recovery; Windows parent-process crash/reboot NOT_RUN |
| Post-boot SYSTEM data differs from legacy snapshot | **Do not restore old snapshot**; keep SYSTEM task/evidence for explicit reconciliation | Existing guarded recovery script tests; physical NOT_RUN |

## AI-09 operator acceptance checklist (NOT authorization to execute)

**Prerequisites:** local device-owner approval, a verified elevated Windows session, unique physical executor lock, exact SHA and CI success for AI-01/02/03/04; separately reviewed rollback. Execute in disposable Win10/11 VM before the Work-PC. `#1161` remains NO-GO until physical evidence exists.

1. Read-only inventory: OS/user SID, interactive and SYSTEM task principal/action/trigger/LastResult, process owner and listening port/PID incarnation; canonical launcher `NEXOWIRE_STATE_DIR`, `ProgramData` parent ACLs and reparse chain, source and target volume free bytes. Record `4.1 GiB` hard gate and `8 GiB` advisory independently.
2. In an isolated clone, create trusted offline backup and verify SQLite `PRAGMA quick_check`, `idempotency_records` row count, durable main/WAL hash/tree hash, and recovery backup membership. Exercise full rollback on the clone only. Hash/report metadata, **not** credential file content, tokens, plaintext DPAPI or SQLite dump.
3. Before any real quiesce: re-read launcher path/identity and source digest, journal phase, task/port owner, WAL/SHM identity, and recovery task/action from independently registered Windows scheduler. Recheck both actual volumes. If any is unverified or `UNKNOWN`, stop.
4. Only after owner authorization: quiesce the legacy writer, assert disabled task/no listener/no writer, capture immutable before hashes, copy into private stage with exclusive destination creation, protect ACLs, issue matching receipt, install trusted SYSTEM Hub task, verify owner/principal and state root. Never manually delete stale `-wal`/`-shm`, run checkpoint/VACUUM on live state, or silently overwrite an existing stage.
5. Treat healthy SYSTEM Hub as `AWAITING_PHYSICAL_ACCEPTANCE`, **not** `READY`. Observe after-login and before-login liveness, real LocalMachine DPAPI readback (metadata in report only), controlled Broker effect and revoke, two reboot cycles, two WAL recycle cycles, and absence of replay. On failure, independently compare durable source/system trees and journal phase before choosing whether recovery is safe.
6. If SYSTEM has any new writes, an unknown operation, an ambiguous commit, an unexpected task/process owner, or interrupted rollback, **do not launch the old user Hub with a stale snapshot**. Keep independent recovery evidence and both state trees; coordinate manual reconciliation with the operator.

## Evidence collection template

Record exact SHA, Windows build and Node version, source-root canonical path as redacted metadata, source/target volume identity, before/after free bytes, protected ACL evidence, the ordered event timeline, source/destination tree SHA-256, main SQLite and `-wal` SHA-256, durable file count/bytes, `quick_check`, idempotency row count, recovery journal phase, task principal, owner/PID incarnation, rollback decision and reason, reboot timestamps, and `PASS/FAIL/SKIP/NOT_RUN` by check. No live or private state is published.

**Remaining coordinated review:** Physical rollback must not run without AI-09's exclusive execution lock and owner approval. The current C:-anchored protected path constants need separate non-C: Windows installation coverage with AI-01/AI-05 before claiming universal Windows installer compatibility. Root-level Windows PowerShell failure-injection tests are not necessarily executed by the current AI-04 CI workflow; proof must name the exact test command, runner, SHA and result.

**Physical acceptance: NOT_RUN.** **Production state and tasks: UNCHANGED by AI-02.**

**Hosted negative-fixture isolation:** scheduler operations are intercepted by local PowerShell functions; unexpected task identities, COM/CIM access, legacy task enablement and HTTP calls fail the fixture. This lane is intended only for disposable CI runners, not the Work-PC. Actual PowerShell results remain NOT_RUN until the CI owner records exact-head evidence.

Native error evidence: `test/ai04/transactional-native-sqlite-errors.test.ts` exercises both real SQLite error codes with normal and interrupted mocked rollback. Both disposable databases retain exact SHA-256, `quick_check=ok`, original row count and value. Local test used orchestrator blob `9be7267951f70c5840ebee7979e449193563661f`, transpiled without diagnostics; 4 tests, 4 pass, zero skip. This is not a physical Windows rollback or real disk exhaustion claim.

Additional exact-source local evidence: `test/ai04/transactional-cutover-preflight-races.test.ts` blob `8282e69e80f4fd136e1d5333712735163182f784`, disk gate blob `629dc14fd8cd9ea5216a01b545eda47c3c97733f`, unchanged orchestrator blob `9be7267951f70c5840ebee7979e449193563661f`. Node 22.16.0 local transpiled fixtures: 7/7 PASS across this file (3 tests, 6 mount-boundary cases plus abrupt worker death) and native SQLite errors file (4 tests), zero skip. The original source files were verified by Git blob hash; this is not a full repository build or a real Windows reboot/rollback receipt.

**Cutover/recovery execution exclusion:** the elevated Node cutover creates a private, empty `cutover.lock` before publishing its recovery task and holds a read/write file handle across all writer transitions. The PowerShell recovery must open the same file with `FileShare.None` before reading the journal or touching any task; competing recovery fails closed. Node releases its handle before direct rollback and in `finally`; recovery releases its handle in `finally`. The lock file itself remains as protected evidence, and OS process death releases the handle. A Windows-only disposable fixture tests a live Node handle versus PowerShell recovery, then retries after close using the same journal. This does not replace AI-09's exclusive physical executor lock, and real Windows sharing/ACL/reboot acceptance is NOT_RUN until independently executed. Existing older on-disk recovery scripts are not rewritten by this change.

**Windows parser fixture command length:** rendered recovery source at `90d8eec` was 13,315 ASCII characters; the old nested Base64 command required approximately 48,552 characters, above Windows CreateProcessW's 32,767-character limit. `test/system-hub-cutover-recovery.test.ts` now passes only a short encoded `Parser::ParseFile` wrapper, reading the exact generated script from a disposable BOM-marked input file. It never executes recovery. Actual Windows parser result is NOT_RUN until explicitly invoked.
