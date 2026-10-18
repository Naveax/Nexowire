# P0 Windows Process Manager v3: Job Object ownership (#541)

**Status:** source-only DRAFT; no running Nexowire Agent or installed release changed. PR #543 has merged. This DRAFT targets `main` and preserves its bounded failure-reporting contract. Never close #541 or merge without physical and exact-HEAD Windows CI acceptance.

## Evidence and boundary

Windows Node.js `child_process.spawn` does not expose `CREATE_SUSPENDED`, `AssignProcessToJobObject`, or a Job handle. A purpose-built native guardian in `native/windows-job-owner.c` runs each **headless** volatile shell, or each **ordinary headless** durable worker shell, with this order:

1. Create a private Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, without breakaway flags.
2. Create the shell with `CREATE_SUSPENDED` and connected standard streams.
3. Call `AssignProcessToJobObject`, then `IsProcessInJob`. On any error, **terminate the suspended process and refuse the launch**. No unmanaged fallback.
4. Record root PID plus `GetProcessTimes` creation FILETIME in an exclusive fresh marker file, flush, then `ResumeThread`.
5. Keep the sole non-inheritable Job handle in the guardian. Poll `JobObjectBasicAccountingInformation.ActiveProcesses`; ordinary Job completion does **not** signal `WaitForSingleObject(job)`. When the guardian closes/crashes, `KILL_ON_JOB_CLOSE` kills all current Job members.
6. For **volatile** sessions, watch the owning Agent process handle, closing the Job when that process exits unexpectedly; for **durable** sidecar shells, watch the sidecar worker process (not the Agent), so Agent restart preserves the task while sidecar crash closes its Job.

The code deliberately avoids `taskkill /T /F` for fresh verified Job sessions; it **preserves PR #543's bounded taskkill fallback and truthful `requested/unconfirmed` status** for legacy/unowned paths. A `requested` cleanup result is the successful attempt, not an independent complete descendant inventory; the Process Manager additionally waits for guardian close and verifies shell root before saying the session is exited.

## Deployment

The EXE is **built from source**, never committed. `scripts/build-windows-job-owner.ps1` selects Zig or Visual C++ toolchain and produces `native/windows-job-owner.exe`. Windows CI executes this compilation before integration tests. The Windows release builder places the EXE at `app/dist/native/windows-job-owner.exe` so built JavaScript resolves the exact deployed path. Missing helper is a hard failure, not a silent uncontained shell.

## Explicit non-guarantees

- Nested jobs: modern Windows supports nested jobs but incompatible parent Job limits, access tokens, protected/UAC elevated processes, and breakaway settings may reject assignment. Failure before `ResumeThread` must fail closed. No attempt to bypass system policy.
- A process started outside the Job through an elevated broker, COM activation, service, independent scheduled task or other detached trust boundary is **not** proven owned by the Job. Do not terminate arbitrary PID descendants, and do not equate process-tree ancestry with Job membership.
- Existing `ui_target='private_desktop'` durable workers intentionally keep their distinct isolated-desktop launch and policy gates. Do not label them `treeOwnership=windows_job`; their cleanup is `unconfirmed` unless another mechanism proves it.
- Recovered old volatile sessions may be marked `orphaned` based on PID liveness but lack a retained guardian handle / creation identity. Existing recovered-PID stop rejection remains in effect.
- Durability depends on the sidecar worker and Job guardian continuing to live; Agent disconnect does not kill durable tasks, but worker/guardian crash does close the Job. A worker may survive only if it can reattach its own resources.
- `KILL_ON_JOB_CLOSE` is a termination mechanism, **not** an assurance that every arbitrary platform-independent child, external service, suspended process or stdout handle has exited. No automatically declared success without the recorded evidence.
- `process.prune` removes completed metadata and never prunes `running`/`orphaned` sessions. Capacity defaults to 128 with atomically reserved start slots.

## Verified Windows physical gates on Work PC

- Full historical `test/process-manager.test.ts` completed **11/11** and exited 0 without previous hanging behavior.
- Physical synthetic tests: root killed while child remains, guardian force-killed with marked descendant, volatile synthetic Agent force-killed; no arbitrary processes terminated, and matching root/guardian/child PIDs plus timestamps verified before forced kills.
- Combined initial durable + Process Manager + Job regressions: **21/21 PASS** for combined physical targeted gates, including 128 actual Windows Job sessions, safe reclaim, root/guardian crashes, durable worker crash cleanup, stream piping and fail-closed launch; exact-head CI is still a separate release gate.
- Windows CI exact-HEAD results and native MSVC release-build gate must be inspected after PR creation; source-only Work PC success is not production deployment acceptance.

## Reference API contracts

- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocessw
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject

## AI Screen launch audit coupling

The new `src/agent/windows-job-owner.ts#spawn` is explicitly recorded once in `scripts/ai-screen-launch-sinks-baseline.json`; `npm run ai-screen:launch-audit` passes with 57 observed direct callsites / 44 signatures. This is an inventory update for #402 review, **not** evidence of containment for native/COM/privilege-elevated launch paths. The auditor remains enabled and rejects future unrecorded launch sinks.
