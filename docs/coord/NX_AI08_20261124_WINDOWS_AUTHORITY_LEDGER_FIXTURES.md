# AI-08 Windows authority and ledger fixture acceptance

2026-11-24. #1205. Exact integration base d2696376aae7a23aa9e0df01c19aa5c9b07f0595. Source-only isolated Draft. No production device action.

All seven complete test files reviewed. Exact blobs additionally verified unchanged in coordinator #1250, AI-01 #1257, AI-02 #1243 and AI-03 #1254. None has an exact literal reference in the eleven base workflows; this does not exclude indirect execution.

| File | Reviewed Git blob | Minimum cases |
| --- | --- | ---: |
| test/idempotency-journal-concurrency.test.ts | f8b86d4405a0ebd4f0b5b3eccd04dc5ab93c0e02 | 1 |
| test/guardian-sqlite-replay-ledger.test.ts | 85a8958f7b4480ff4f4e9011a1f07e5337eb16dc | 14 |
| test/guardian-sqlite-signed-command.test.ts | 3ef6a0da300300847784745b76764f4d1bc3fe15 | 3 |
| test/privileged-broker-denial.test.ts | c8daa89bb4233f9f2b4cc186aa1a8dd94ea7425f | 2 |
| test/privileged-broker-health.test.ts | 1e1965b21fab810896dcbcecc60ddbeb56e0a683 | 1 |
| test/windows-programdata-acl.test.ts | c137ace0c2f00386e785f033adaa638bf436a40a | 12 |
| test/windows-uac-status.test.ts | ce60dada49a8f9e6cad6c1afe2f5e645115e2d2d | 6 |

39 expected cases per Node version, not yet measured. IdempotencyStore uses withDatabase/finally to close Win32 handles; fixture-owned subprocess and temporary DB are the only objects used by concurrent journal test. Replay ledger uses temporary SQLite databases, fixture-only child processes, ephemeral Ed25519 keys and synthetic approval callbacks; no production ledger is opened on Windows. Broker health starts an authenticated loopback-only fixture on an ephemeral port, closes it in finally, exercises only /health and compares a read-only elevation observation; no effect dispatch. Denial test redacts synthetic private text. ProgramData ACL tests use read-only system ancestor inspection, temporary files and pure ACL argument construction, not ACL modification. UAC status uses injected consent counts and broker observation; no consent interaction. Run only on disposable hosted workers.

Independent of #1252/#1253/#1255/#1258; no modification to those green specialized lanes or their active general CI. Exact checkout, immutable inventory and source bytes, positive TAP floor and zero fail/skip/cancel/todo, bounded 180s per file and 32min job. Three negative/source pin contracts. Receipt is lane-local, not complete coverage; no release prerequisite until coordinator establishes required checks on combined SHA.

AI-01's new handoff receipt fixture b43b45de2b6c85177ac7f0e15a66c3d321661d45 and AI-02 controlled-cutover fixture 494b60fc0bd67fe5832fd72e282e641ab9f072f4 are reviewed separately in their PR comments; both await their matching implementation source in integration. Remaining installer-dependent runtime ACL, mixed symlink early return and recovery script mutation harness require owner coordination. No main merge/tag/release/physical SYSTEM or CORE acceptance. Exact child results pending.

## First exact-child result and independent failure reporting

Initial SHA 7548ccc85dbffebb3586f578226fc1b8f7a86801, Windows matrix 45383783577: both Node jobs 138409325754 and 138409326712 failed. Four preceding files gave 20/20 PASS per version. Broker health returned package version 1.0.9-exp.0, but the historical test accepts only X.Y.Z. The auth and actual token assertions before version check passed; final method assertion and two remaining files were not executed. Owner handoff #1254 requests exact independent package.json equality, preserving all other assertions. Do not alter another owner's test or version, broaden regex, drop the test, or mark it green.

Runner now records complete per-file attempted outcomes (schema v2), continues only the already-reviewed independent files after process or TAP failure, and exits nonzero after emitting a failed receipt. Source/admission failure still aborts. Failed files have no trusted assertion counters and contribute no PASS evidence. Added two contracts for failure continuation, incomplete/forged receipts and source admission abort. Old run remains FAIL; new SHA is a distinct execution, not a retry of unchanged source. Until the owner correction is reviewed, the known health failure remains expected to block acceptance.
