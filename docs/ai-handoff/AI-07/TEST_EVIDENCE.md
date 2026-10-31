# AI-07 | TEST_EVIDENCE — scoped native probe and OS report

## Exact parent checkpoint
- Draft [#990](https://github.com/Naveax/Nexowire/pull/990), source parent `a6900ab9695d3524ca8999d3bd62975c3d4bab59`, base `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9`.
- Parent [CI #41249427088](https://github.com/Naveax/Nexowire/actions/runs/41249427088): at last read Node 22 and Node 24, Linux-native, WSL2, macOS-agent-lifecycle, security-operational **SUCCESS**; Windows browser-live `in_progress` at DPAPI/pre-logon step. Do not call this a full 7/7 PASS unless it becomes terminal.
- New tests added by this source edit: `node --test --import tsx test/ai07-sandbox-readback-unknown.test.ts`. **Not locally run**, and not PASS until its new exact-HEAD CI completes. The test exercises 13 reported uncertainty keys × false/true/null/undefined, getters, Proxy descriptor failures and benign readback control. No `skip` or changed baseline assertions.

## Existing native safety evidence (not production acceptance)
- Linux `native/task-os-sandbox-linux-namespace-probe-p07.c`: `--selftest-only`, rootless user/mount/PID/net/IPC/UTS checks, parent readback of `pid_for_children`, pidfd parent-death fence, bounded test-owned PID1/descendant cleanup, post-close_range no inherited FD 0+, `seccomp` EPERM on socket/openat. No arbitrary task or app-level execution; unsupported readback fails.
- Linux negative suite: `test/ai07-sandbox-linux-{parent-death,pidfd-orphan,fd-seccomp,openat2-root,setsid-breakaway}.test.ts`, with intentional failing controls. `setsid` is independently observed escaping POSIX process-group SIGKILL until test-owned exact PIDFD reap. Linux `openat2` cannot alone prevent hardlink boundary escape.
- Windows `native/task-os-sandbox-windows-appcontainer-probe-p07.c`: effective TokenElevation/TokenType/TokenIsAppContainer/TokenAppContainerSid/TokenUIAccess, Mandatory IL, Job flags, PID/creation FILETIME readback; accepts only `--selftest-only`. A normal runner returns BOUNDARY_NOT_PROVEN. Self-observed diagnostics cannot authorize a worker.
- Windows `test/ai07-sandbox-windows-msvc-p07.test.ts`: compile `cl.exe /nologo /W4 /WX`, reject non-selftest argument exit 64; normal host test returns 77; no privileged operation. Actual native compiler evidence must be taken from independently verified workflow or disposable Windows VM and never inferred from Linux source-only tests.
- Deny-only runtime assessment always has `dispatchAllowed=false`, `mayResumeSuspendedRoot=false`, `mayReplayOriginalMutation=false`, `nativeKernelBoundaryVerified=false` regardless of `reported` input.

## Missing external acceptance
- No independent protected native worker issuer/receipt, cgroup/Job descendant-drain or revoke proof, file/network/IPC/handle/env identity binding, signed owner/device/session/grant and external CAS. No physical NAVEAX/Work-PC acceptance and no CORE enable.
- This docs+test/source commit requires its **own exact SHA** and CI logs; parent run #41249427088 is not proof of the successor.
