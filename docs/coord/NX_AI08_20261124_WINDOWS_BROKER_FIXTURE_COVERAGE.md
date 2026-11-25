# AI-08 | Windows Broker, UAC and prelogin source fixture coverage

2026-11-24. #1205. Source-only Draft, no production device operation.

Base #1160 d2696376aae7a23aa9e0df01c19aa5c9b07f0595. #1252 is an independent existing Draft with active DPAPI Windows CI; this change does not modify or supersede it. No source-path overlap with #1252. No changes to general CI or release provenance matrices.

## Reviewed additional files

All 11 existing workflow files were searched for explicit invocations of these tests; none found. This does not prove absence of indirect execution. Full source was inspected and the same file pins verified on #1250 candidate 1a837b0069b3d8c91401b1c454f62eba2babd6b9 and AI-03 #1239 head 9a86e592576085fa5bf86a9b27cfa84b1806979e.

| File | Reviewed blob | Minimum TAP count | Scope |
| --- | --- | ---: | --- |
| test/privileged-broker-root-boundary.test.ts | 5ece7b2d5668bd26279ea809b831c1831c54c17f | 4 | Pure root/path/deletion policy, denied read-only status overrides |
| test/privileged-broker-shell-trust.test.ts | c3879222455f63db7cc099862e837af7a4c29c1f | 4 | Fixed shell environment and read-only task lookup with isolated fake executable |
| test/privileged-broker-elevation-shell-trust.test.ts | b090af47ad77a8b8303ddb13afa201f7b8b6f0fd | 3 | Read-only token observation, fixed PowerShell identity |
| test/privileged-broker-task-control-identity.test.ts | dffaf30e54ff07e0316f2ac32ffad44db1ab7809 | 2 | Source ordering and synthetic task principal/action objects |
| test/windows-prelogin-handoff.test.ts | c01f2c1b83262d3b096c1612ea98a4d488b9a3cc | 7 | In-memory fake socket/identity/handoff regressions, no live connection |
| test/windows-uac-shell-trust.test.ts | f58ea473c633c3fe91571da59f4a915f1bb661a2 | 3 | Read-only UAC observation, synthetic invalid executable |

Total minimum 23 cases in six files per Node version. This is an execution target, not measured PASS.

The mixed-platform Broker task-control ACL file is intentionally excluded from this zero-SKIP lane: it has an explicitly non-Windows-only test that would skip on Windows. Future partitioning must preserve explicit OS-specific evidence; do not remove or mislabel the skip.

## Implementation

Independent GitHub-hosted Windows Node22/24 matrix; exact source checkout; no persisted checkout credentials. The runner validates immutable inventory, reviewed Git blobs and checked-out file bytes before executing any child, rechecks each file before launch, bounds each child at 180 seconds, rejects incomplete TAP, skips, failed status, cancellation and counts below the reviewed minimum. JSON receipt is emitted only after all six complete. Failure metadata uses process exit/error/signal and durations. Three contract tests exercise pinned bytes and negative cases.

The new workflow triggers on relevant PR changes; it is separate source acceptance, not yet a release prerequisite. The coordinator must incorporate its required check and verify the combined SHA before claiming coverage. Exact new child CI PENDING. No duplicate dispatch, no main merge, no stable publication or physical SYSTEM/CORE acceptance.
