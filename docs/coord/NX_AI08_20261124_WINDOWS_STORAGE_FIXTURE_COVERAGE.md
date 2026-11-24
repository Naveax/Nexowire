# AI-08 | Windows storage and recovery source-fixture coverage

2026-11-24. #1205. Exact integration base d2696376aae7a23aa9e0df01c19aa5c9b07f0595. Source-only Draft. No production device changes.

Independent from #1252 (Windows state/ACL/DPAPI) and #1253 (Broker/UAC/prelogin), both of whose Windows-specific lanes already passed on their own SHAs. Do not re-trigger their CI. All 11 base workflow files were inspected for explicit invocations of the seven files below; none found. Indirect execution is not ruled out.

| Fixture | Reviewed Git blob | Minimum tests | Scope |
| --- | --- | ---: | --- |
| test/agent-operation-journal.test.ts | e8db5f0ac93641145266518593e28a55bead90d2 | 12 | Temporary SQLite journal, duplicate admission, durable UNKNOWN, capacity, corruption, metadata, process result |
| test/guardian-sqlite-crash-recovery.test.ts | c34bed39cb341da1c77601a05a5b0926bf7b94c3 | 2 | Kill only a fixture-owned child with disposable DB; before/after commit recovery |
| test/ai06-sqlite-task-absence.test.ts | 4ddbd0ca392b7b2172a8cac1751fcf6f3372f441 | 2 | PowerShell AST extraction of read-only absence guard with synthetic lookups |
| test/journal-unknown-save-sticky.test.ts | 987c663a5337c0a48541e4d4f3b02cb5e20912d3 | 6 | Temporary JSON checkpoints, UNKNOWN state and re-admission |
| test/journal-save-admission.test.ts | 61d2c9b2b24c4336b109f2c8955e086661b2e0bc | 2 | Temporary checkpoint admission and capacity |
| test/journal-save-identity-integrity.test.ts | a10929da4921564ac2eb3e39806883cc75470a27 | 2 | Temporary checkpoint identity/spec integrity |
| test/system-hub-cutover-recovery.test.ts | 3327f05964007ac47eb86755fad207f1e81fc | 3 | Source assertions and PowerShell parser only; does not execute recovery script |

All seven complete files were inspected, and the exact pins also match coordinator #1250 at 1a837b0069b3d8c91401b1c454f62eba2babd6b9 and AI-02 #1243 at a24e1833387b77bbcd4d6f4b1a33905ba68e6dac. The reviewed target is 7 files / minimum 29 tests per Node version. This is not a measured result.

## Explicit exclusions

- system-hub-controlled-cutover.test.ts changed in #1243 (blob 494b60fc0bd67fe5832fd72e282e641ab9f072f4). Review current AI-02 source after coordination rather than binding an obsolete test pin.
- guardian-sqlite-sidecar-preflight.test.ts returns early on Windows EPERM during symlink creation. Do not infer symlink-case execution from a green Node TAP file.
- idempotency-journal-concurrency.test.ts needs review of SQLite handle ownership/cleanup on Windows before admission.
- system-hub-recovery-failure-injection.test.ts runs a modified recovery script using temporary paths and mocked commands. Requires independent review of the complete recovery script and its command/side-effect boundary.
- Existing native Windows Job, process-manager, WAL-recycle and packaged journal restart cases are already explicitly referenced by CI. Do not duplicate the jobs without proving a coverage gap.

## Execution and acceptance

Separate disposable Windows-hosted Node22/24 matrix. Exact checkout and manifest; complete Git blob and checked-out file validation before any test; each file checked again immediately before its individual subprocess. 180-second per-file timeout, 32-minute job cap; minimum per-file TAP counts, zero failed/skipped/cancelled/todo, positive complete footer. Machine-readable receipt includes exact source SHA, manifest, per-file counters and duration, lane-local NOT_RUN count; sanitized failure metadata. Three contract tests cover pin matching, changed/unreviewed input and rejected incomplete TAP.

This is a source acceptance lane, not yet a release prerequisite. Coordinator must verify combined exact SHA and establish required check before promotion. No physical reboot, real SYSTEM task, production SQLite/WAL cutover or storage power-loss proof. No main merge/tag/release. Child results PENDING.
