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
