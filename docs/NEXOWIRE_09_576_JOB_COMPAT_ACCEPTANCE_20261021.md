# Team #09 AI Screen / Private Desktop + #03 Job integration, 21 October 2026

## Exact revisions and scope

- #602 DRAFT source head `a55ef463e42a65506cfe2723d7fffdd03a17268e`; exact-head CI run `39492809099` **FAILED** on the Windows `browser-live` *Job fast-exit stdout* test, iteration 5. Error: `exited` status before stdout was captured. At that SHA, the other 6/7 jobs succeeded. The failure was **not** in AI Screen's new COM/WSL broker test; do not claim #602 exact-head CI green.
- #576 DRAFT head `91c69f66de88b755309e3c127f23357adcedfb86`, exact-head CI `39492594206` **SUCCESS**, release readiness `39492594153` **SUCCESS**. Its guardian read-only kernel proof verifies an unnamed Job via duplicated handle, process creation FILETIME, membership and safe kill-on-close limits. It fixes output-drain races in the *ProcessManager Job* path, not the separate private desktop PID-only stop.
- #608 DRAFT head `d34c0d3c85bc508be50c2e5f532aa964d8325106`, exact-head CI `39503650650` **SUCCESS**, release readiness `39503650638` **SUCCESS**; it is an independent #576/#598 integration reference, not a replacement for private desktop acceptance.
- This is a **test-only combination branch** based on #602 and merged with #576 with two parents. The source merge used `git merge --no-ff` and returned no conflicts. Read-only merge-tree of #602 and #608 also returned success. This branch is **not intended for production merge**, because #576 is owned by #03. We added only one #09 negative test file and one Windows CI test invocation on top of the combined source.

## Verified isolated Work PC evidence

- Zig compiled the reviewed Job owner binary in this worktree; this is an ephemeral testing binary, not a deployed native Agent helper.
- `node --test --test-concurrency=1 --import tsx test/private-desktop-job-compat-negative.test.ts test/windows-job-owner.test.ts test/windows-job-attestation-spoof.test.ts test/windows-job-named-handle-caveat.test.ts`: **15/15 PASS, zero skipped**, including fast-exit stdout/stderr cases, synthetic guardian-death contained Job reaping, forged NWJOB5 marker rejection, changed creation ticks rejection, and Job handle spoof rejection.
- The five new #09 tests run exclusively read-only source audits, pure picker-dispatch fixtures, and invalid-argument kernel preflights. They do **not** call active user focus, mouse, keyboard, Default input, UAC, or physical desktop switches.

## Exact fail-closed boundaries

1. #576 `verifyWindowsKernelJob(pid,creationFiletime,guardianPid,jobHandle)` validates the *actual* kernel Job/provenance before resuming its owned synthetic process. Invalid PID, fake creation ticks and forged handles fail closed.
2. **Separate UNSOLVED P0:** `windows-private-desktop.ts:killTree(pid)` calls `taskkill.exe /PID <pid> /T /F` from persisted `launchedPids` with no immutable HANDLE, process creation FILETIME or Job membership validation. A PID can be recycled. The #09 test intentionally documents this with a deterministic source guard; it does not try to kill another process. Replacing this with the shared #03 Job owner requires explicit lifecycle integration and independent negative physical acceptance by #03.
3. Explorer/COM file-picker mutation is limited to a tracked private HWND, exact owned process/session and unambiguous semantic control. If it jumps to an untracked Explorer PID, `PICKER_WINDOW_CHANGED` is returned before edit/invoke. Subsequent attempt with consumed grant is `PICKER_GRANT_INVALID`, never a fallback to owner Default.
4. Synthetic secure desktop `Winlogon` transition and emergency stop fail with `PICKER_DESKTOP_UNSAFE`, no edit or button invocation. Real UAC was **not** triggered, no physical HWND focus change was attempted.
5. #602 CMD `call`/`@call`, COM, WMI, WSL, Windows Terminal known literal broker denial remained PASS with #576 merged. Dynamic or renamed broker invocation is not proven contained.

## Remaining acceptance gates: **BLOCKED**

- Private desktop PID-only stop must use OS-verified Job/handle creation identity and must never kill an unrelated recycled PID.
- Windows Explorer/COM cross-process file dialog and indirect GUI descendants need a safely contained user/session or VM. The existing read-only Common Item Dialog inventory does **not** prove positive file acceptance.
- Authenticode/validated publisher + protected helper ACL with immutable file identity across launch; current SHA-256 preflight alone is subject to TOCTOU.
- Real UAC secure desktop and second display/user-active foreground/input acceptance can only be run in an authorized isolated VM/other session. Do **not** use the user's active desktop to demonstrate these.
- A file-picker may pass an authorized local path; streaming must use #08 chunked artifact API. Do not paste large file bytes to clipboard or one browser input.
- No live Agent/Hub/Broker, production UI, Default focus, physical keyboard/mouse changes. No main merge. #480 patch already equivalent in main through #570, **do not blindly merge #480**.

**CI source-only PASS is not physical production acceptance.** Collect new exact-head CI for this combined test branch independently.
