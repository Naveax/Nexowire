# AI-07 test evidence (2026-10-31)
- Linux isolated workspace, Node 22.16.0: `node --experimental-strip-types --test test/ai07-sandbox-windows-probe.test.ts`: **exit 0**, **2/2 PASS**, **static source only**.
- New mutation-state regression: written but **NOT RUN LOCALLY** against full repository (tsx and whole repo unavailable in workspace).
- Native Windows MSVC build and AppContainer/Job readback: **NOT RUN**; disposable Windows VM unavailable. No physical PASS claimed.
- Linux namespace selftest in disposable lab: **NOT RUN**. No physical PASS claimed.
- Whole-repo `npm run typecheck`, existing tests, new exact-head CI: verify via remote Actions; prior #859 CI run `40547392793` is **not** a new-head result.
- No real installed/signed Agent, two-device owner grant/CAS, physical file/network/handle/descendant/revoke evidence: **NO-GO**.

- AI-07 hostile-input source negatives: added; exact-head CI pending, no physical validation claimed.

- Revoked Proxy negative test added: `Array.isArray` can throw `TypeError` for revoked Proxies; parser now handles it and returns deny-only decisions. Exact-head CI still required.

## Native probe hardening, current change (2026-10-31)
- Linux native source: `test/task-os-sandbox-linux-native-p07.test.ts` verifies compile, deny-only CLI, and static FD 0..MAX / strict seccomp; opt-in namespace selftest remains separate from source tests. Actual physical namespace selftest **NOT RUN** in real installed Agent.
- Windows source: `test/ai07-sandbox-windows-probe.test.ts` checks MSVC Advapi32 linker directive and primary token / KILL_ON_JOB_CLOSE readbacks; Windows MSVC compile/runtime **NOT RUN locally**. Dedicated Windows runner with Visual Studio dev environment still required.
- New HEAD CI result and exact exit statuses must be taken from GitHub Actions for that SHA; earlier CI `41195960785` 7/7 SUCCESS was only for `10463c1a9bacad950b053c9106ee580ff6fed1ad`.


## This continuation
- Linux probe source-level regressions now assert bounded poll, WNOHANG and kill of the test-owned child, exit 78 on timeout. Existing native C compilation on CI must reverify the new SHA.
- Windows-only `test/ai07-sandbox-windows-msvc-p07.test.ts` attempts actual MSVC /W4 /WX build, tests arbitrary command rejection and expects the ordinary runner's AppContainer/Job readback to return 77. On Linux this OS test reports NOT_RUN/unsupported (not PASS); Windows job in current workflow does **not** run npm test, so independent Windows executor must run the explicit test. No claim of actual Windows native build until such a run is observed.

- Handoff ownership map reviewed against the 31 Oct 2026 team plan: docs-only correction, no executable change or native security acceptance. Latest source test22 on `439523c603840de7b8678b047ef06fb140f3970c` logged 2,257 tests (1,964 pass, 0 fail, 291 skipped, 2 TODO). Windows-only native MSVC case was explicitly SKIP on Linux; not physical evidence. CI 41198275210 was still IN_PROGRESS when observed.


## Native PID-namespace orphan and Windows SID negative regression
- `test/task-os-sandbox-linux-native-p07.test.ts`: new static source assertions for `setpgid`, child `PR_SET_PDEATHSIG`, bounded group termination and PID > 1 guard. Existing Linux C compilation and command rejection remain mandatory on exact-head CI; full namespace selftest not claimed.
- `test/ai07-sandbox-windows-probe.test.ts`: negative static assertions require real AppContainer SID readback and `TokenUIAccess==0`. Windows MSVC compile remains an independent required native check.
- Exact head CI results must be read from Actions; no older SHA PASS can be carried forward.


### Forced cleanup negative regression
The Linux source negative test now checks that group signal errors do not short-circuit direct child SIGKILL; that forced waitpid is bounded, and success is contingent on observed reap. CI Linux compilation/negative CLI and full Node tests must be confirmed on this exact SHA. No lab cgroup, physical Windows native or installed Agent acceptance is implied.

### Additional native regression gates
- Linux native C and `test/task-os-sandbox-linux-native-p07.test.ts`: assert parent `pid_for_children` kernel namespace identity, exact isolated process group, and post-seccomp syscall `openat` explicit `EPERM`. Requires current exact-HEAD Node22/24 CI run after commit; no local host namespace execution or installed Agent permission.
- Linux C source-only compile/negative CLI success is insufficient evidence for an actual namespace+seccomp kernel PASS, because selftest is opt-in and may return BLOCKED on runners without unprivileged user namespace support.

### Kernel namespace witness ordering
- Source negative test checks that `pid_for_children` is read from the outer parent **after** the first fork and **before** PID1's gate release. Prior one-stage check was invalid because the link is empty until a child is created (Linux pid_namespaces(7)). Exact-head CI and optional isolated Linux namespace selftest remain separate evidence; unsupported kernels must return BLOCKED.

### PID1 gate ordering and negative signal handling
Linux source regression now checks `PR_SET_PDEATHSIG` occurs before the PID1 second approval read, and the gate writer explicitly suppresses SIGPIPE so broken pipe produces a controlled denial path. New exact-HEAD native compile and complete Node22/24 test results are required. No disposed Windows/Linux physical OS worker test is inferred.

### Additional isolated regressions (2026-10-31)
- Linux native source assertions: both inner success/error PID1 waits are monotonic and bounded; all ambiguous reap/forced-kill outcomes are nonzero and never reported as native physical acceptance. Exact-head CI must confirm C compilation and test suite; no opt-in physical namespace test claimed.
- Hostile-input Node test now includes NUL-embedded argv, NUL-embedded task-root and oversized task-root; all must include `INVALID_TASK_INTENT`, no getter evaluation or execution. No other owner's test is weakened.

### Parent-death negative regression
- `test/task-os-sandbox-linux-native-p07.test.ts` now checks direct-child `PR_SET_PDEATHSIG`, recorded original parent PID and fork-to-prctl race guard ordering before `setpgid` and `unshare`. The existing native `cc -Werror` build/deny-only CLI regression remains intact. Exact-head CI required; opt-in physical Linux namespace acceptance still **NOT_RUN** unless separately recorded.

### Aggregate argv negative cases
Added AI-07 test cases with 32768-character single argument, two 20000-character arguments, NUL-bearing string, NUL task root and oversized root. All explicitly assert `INVALID_TASK_INTENT`, `BLOCKED` and a rejected executor promise. This is Node source-level test evidence only; exact-head CI results must be checked on the new commit before claiming PASS.

### Isolated real-kernel negative, distinct from production acceptance
- **Local disposable container:** Linux 6.18.57 x86_64, GCC 14.2, C11 -O2 -Wall -Wextra -Werror. Existing `PR_SET_PDEATHSIG` fixture with pidfd_open, subreaper and exact waitpid: 5 consecutive fenced runs exited `0`; controlled `-DNW07_TEST_DISABLE_PDEATHSIG` variant exited `55` and emitted `NW07_KERNEL_FIXTURE_BLOCKED=55`. Result is real Linux kernel process lifecycle **fixture evidence only**, not native sandbox, authentic Nexowire task, signed worker or physical desktop confirmation.
- **New reproducible repository test:** `node --test --import tsx test/ai07-sandbox-linux-parent-death.test.ts` compiles fenced and intentionally unfenced variants on disposable Linux CI. On non-Linux it is explicitly NOT_RUN. Missing pidfd or kernel features means FAIL/BLOCKED on Linux, never synthetic PASS. Exact-head CI must be reverified on new commit.

### Kernel fixture teardown path QA
- Locally revised disposable Linux 6.18.57/GCC 14.2 kernel fixture was compiled with `-Werror` for both modes; 3 repeated positive (exit 0, PIDFD+SIGKILL+waitpid verified) and 3 intentionally disabled parent-death negative (exit 55) runs. The owned test/cleanup is bounded. This remains **only** a disposable kernel subprocess lifecycle fixture and cannot authorize native Nexowire task execution.

### Real Linux FD/seccomp kernel negative fixture (1 Nov 2026)
- **Local isolated container**, Linux `6.18.57 x86_64`, GCC `14.2.0`, `cc -std=c11 -O2 -Wall -Wextra -Werror`: protected `exit 0` with kernel PASS marker explicitly **NOT_NATIVE_WORKER_ACCEPTANCE**; `-DNW07_TEST_DISABLE_FD_CLOSURE` `exit 53`; `-DNW07_TEST_DISABLE_SECCOMP` `exit 55`. The no-seccomp variant must prove socket/openat/getpid are supported by the host; if denied by external policy, return BLOCKED `58`, not a fake PASS. Test-owned direct child is reaped with monotonic bounded waits.
- Repository command: `node --test --import tsx test/ai07-sandbox-linux-fd-seccomp.test.ts`. Separately tested a standalone copy under Node 22 `--experimental-strip-types --test` with exit 0 (1/1 PASS), **before commit**; exact HEAD CI must establish repository status independently. Only this narrow kernel fixture is real OS evidence: production worker, AppContainer, namespace/cgroup isolation and whole descendant revoke remain NO-GO.

### FD/seccomp fixture extra negative and failure-path teardown
- **Isolated local container** Linux 6.18.57/GCC 14.2, `cc -O2 -Wall -Wextra -Werror`, 4 variants: protected exit `0`, disabled close_range exit `53`, disabled seccomp exit `55`, disabled synthetic environment clearing exit `59`. All four reproduced after changing the fixture to use bounded exact-child SIGKILL/reap even on monotonic-clock failure. Real local kernel FD/seccomp readback and userspace environment test are separate from task/credential production acceptance; new exact-HEAD CI required after commit.

### Early parent-death race mitigation source review
- Added native probe pre-fork self `pidfd_open`, inherited parent pidfd post-`PR_SET_PDEATHSIG` checks before/after gate and explicit FD cleanup. Local isolated Linux 6.18.57 / GCC 14.2 proof of mechanism: six standalone kernel fixture runs simulated parent death **before** child-installed `PR_SET_PDEATHSIG`; inherited pidfd `poll(POLLIN)` detected it and fixture exited `87` in all 6, with process reaped by a subreaper. This does **not** execute the native namespace selftest in CI or independently attest a task worker.
- Exact-head native compile and Node source assertion CI remain pending. Protected production descendant cleanup, cgroup v2 and Windows native worker still unavailable.

### Early-orphan PIDFD: independent real Linux kernel test
- Local isolated Linux 6.18.57 x86_64 / GCC 14.2, `cc -O2 -Wall -Wextra -Werror`. Prior standalone fixture verified 4 protected `exit 0` and 4 intentionally disabled guard `exit 55`; both require subreaper and bounded wait. The new repository test reproduces this scenario and must pass exact-HEAD CI; no assumption that this proves native OS worker identity or descendant drain.

### Kernel without pidfd syscall macro (2026-11-01)
- New Linux native build negative compiles a test-only transformed C diagnostic after undefining `SYS_pidfd_open` immediately before its feature guard; `-Wall -Wextra -Werror` must succeed, and unsupported arbitrary CLI input still exits 64. This is **only a compile/deny negative**, not execution of rootless namespace selftest or real production kernel proof. Exact-head CI required.

### 2026-11-01 independent disposable openat2 negative
- **Isolated local kernel:** Linux 6.18.57 x86_64, GCC 14.2.0, C11 `-O2 -Wall -Wextra -Werror`. Fixture only operates under a new `/tmp/nw07-openat2-source-XXXXXX` and removes its own files. Four variants: guard flags `exit 0`; no RESOLVE_BENEATH `exit 55`; no RESOLVE_NO_SYMLINKS `exit 56`; missing hardlink-inode warning `exit 57`. 10 repetitions each, **40/40 expected**. Unsupported `openat2` returns BLOCKED 70. The test does NOT prove production OS root confinement. Exact-head CI still required.
- Repository test command: `node --test --import tsx test/ai07-sandbox-linux-openat2-root.test.ts`. Tests are not run on non-Linux and cannot be counted as physical Windows PASS.

### Hidden argv metadata negatives (1 Nov 2026)
New `test/ai07-sandbox-hostile-input.test.ts` negative cases assert `INVALID_TASK_INTENT` with a hidden throwing getter, symbol-keyed metadata, nonindexed field, and a throwing Proxy ownKeys trap, without evaluating the getter. Exact HEAD CI required; never interpret source-only blocked status as native worker isolation.
