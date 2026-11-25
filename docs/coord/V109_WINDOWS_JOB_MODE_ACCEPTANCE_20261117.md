# Windows Job guardian profile-specific QA evidence — 2026-11-17

## Source scope

- Parent source: integration Draft PR #1160, `1b070bb9c400fd3833bb7fbde5ccc1738bdfb790`; read-only disk preflight was committed separately as `3fc6f167f02ac292a961e089884a43195e3b2d11`.
- The Work-PC shell environment specifies `NEXOWIRE_CORE_APPROVAL_MODE=local-owner`. `useWindowsJobForProcess` intentionally selects ordinary user processes for that mode, rather than a native Windows Job guardian.
- The original `test/process-manager-tree-cleanup.test.ts` incorrectly required `treeOwnership=windows_job` for the forced-root-loss test regardless of local-owner mode; it failed with `actual=undefined`, `expected=windows_job`.
- Compiled the source-only `native/windows-job-owner.exe` with local Zig, including SHA-256 manifest. Forcing native Job mode **through the existing remote shell session** produced `WINDOWS_JOB_LAUNCH_UNCONFIRMED` before a Job assignment receipt. Do not claim this failure proves or disproves the guardian on a normal console or hosted Windows CI runner.

## Changes and bounded checks

- The root-PID-loss native Job test now uses the same mode predicate as the production launcher: `useWindowsJobForProcess()`. In the intentional personal local-owner profile it records an **explicit SKIP** rather than a fabricated Job result.
- Other process cleanup tests still execute in local-owner mode; `test/ai05/personal-process-mode.test.ts` continues to check the selection contract.
- The physical Windows Job CI step explicitly sets `NEXOWIRE_CORE_APPROVAL_MODE: native`. This keeps actual native-guardian, kernel-attestation and root-loss tests mandatory on the Windows hosted runner instead of accidentally inheriting a local owner opt-out.
- The new source test verifies that CI still references the root-loss file and requires native mode.
- In Work-PC local-owner mode, the focused combined suite observed **10 PASS / 0 FAIL / 1 SKIP**; the Job loss scenario is that one SKIP. Source-level TypeScript passed. This is not equivalent to native Job acceptance on the physical Work-PC.
- GitHub CI must pass on this new exact SHA before a full release claim. Do not infer GitHub success from previous parent SHA.

No installed Agent, Hub, Broker, UAC state, SYSTEM task, or SQLite was modified.
