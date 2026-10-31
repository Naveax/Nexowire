# AI-07 status (2026-10-31)
- **Status:** REVIEW (source-only), **production NO-GO**.
- Source: PR #859 OPEN/DRAFT, original HEAD `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9`, source CI `40547392793` SUCCESS.
- Original base main: `bd519ee52d56956edfddb1e06bb0856e54e50419`; current main: `a19a228dc6f19fd484cf935e941a00ea625233f8`. Diverged 11 ahead / 32 behind.
- Dedicated branch: `ai/07-isolation-worker-20261031`, child of #859's exact HEAD; this is not a main merge or rebase.
- New exact HEAD and CI: query the live child PR/Actions; never substitute source SHA/run ID.
- Next: independent native OS worker, dispatcher admission, descendant/revoke negative tests, disposable Windows and Linux verification.


## 2026-10-31 continuation: hostile JS evidence handling
- `task-os-sandbox-policy.ts` now reads intent and OS report fields through own data descriptors rather than evaluating plain-object getters; malformed objects, sparse/hostile argv, environment symbols, and throwing Proxy prototype traps fail closed.
- Any malformed non-null report or own `mutationState` (including terminal-looking values) demands `RECONCILE_REQUIRED`, never replay. Inherited spoofing is rejected.
- This is still **source-only**. JavaScript Proxy reflection hooks are inherently executable; the true native trust boundary must authenticate serialized bytes and independent kernel readback outside the JS object graph.
- Added `test/ai07-sandbox-hostile-input.test.ts` negative tests. Do not equate unit tests with Windows AppContainer isolation.

## 2026-10-31 native probe hardening
- Linux disposable probe now atomically closes **every** inherited fd (including 0/1/2), verifies EBADF on those streams, removes seccomp write permission, and prints the static success marker in the outer parent only after successful wait/readback. Existing native compile and opt-in smoke still distinguish physical execution from source.
- Windows disposable probe now explicitly links Advapi32 for MSVC, requires TokenPrimary and a Job KILL_ON_JOB_CLOSE flag in addition to AppContainer/low-integrity/no-breakaway checks. None of these individual checks authorize production confinement.
- Exact-head CI is tracked externally; no CI workflow reruns and no production permission.


## 2026-10-31 source continuation
- Added monotonic bounded readiness and bounded wait/kill of the disposable Linux probe's *own* child, no arbitrary PIDs.
- Added a Windows-only isolated MSVC build and negative CLI test under test/ai07-sandbox-windows-msvc-p07.test.ts. It is unsupported on Linux, not physical PASS.
- Existing PR #990 and AI-07 branch kept; all code remains deny-only, no service/Agent/production effects.

## Owner/contract correction
Current team plan assigns dispatcher/CAS to AI-05, Broker/Job/receipt to AI-04, protected enrollment to AI-02, mTLS to AI-03 and independent native QA to AI-08. The source-only AI-07 executor boundary stays disabled. Updated AI-07 integration request only; no other agents' files touched.


## Current AI-07 native diagnostics correction
- Linux disposable diagnostic now mitigates unshare-created PID namespace init orphaning on timeouts with isolated process group teardown plus `PR_SET_PDEATHSIG`. No arbitrary PID/task is selected; no source-only claim of production cleanup.
- Windows diagnostic also checks AppContainer SID presence and absence of UIAccess. No native executable permission or runtime dispatch enabled.


### Follow-up negative cleanup path
Linux diagnostic forced termination no longer abandons direct-child cleanup after group signal errors. The post-SIGKILL reap is bounded and reports failure when it cannot verify completion. The code remains a selftest-only process, not a production worker.

## Linux PID namespace external-readback gap fixed (31 Oct 2026)
- The disposable probe's outer parent now observes **pid_for_children** namespace identity, not just user/mnt/net/ipc/uts. CLONE_NEWPID does not move the unshare caller into the new PID namespace; the child-of-unshare must be checked separately. The group leader must match the exact unreaped child PID before successful parent attestation.
- Probe runs a post-seccomp `openat` and requires **EPERM**, rejecting misleading ENOENT from an empty pivoted root. Group mismatch is not accepted as verified forced cleanup. Source-only worker status remains BLOCKED.

## Double-barrier fix for Linux pid_for_children (31 Oct 2026)
- Corrected a proposed single-barrier readback: the Linux `pid_for_children` namespace link is empty until the first child is created. Direct probe now forks disposable PID 1 but the PID1 child blocks on a private gate; direct probe announces `P` to the outer observer. The observer then reads `/proc/<pid>/ns/pid_for_children` and releases the PID1 gate only on an independently observed distinct namespace. Any unavailable kernel evidence denies; still no task execution.

## 2026-10-31 PID1 gate failure handling
- PID1 now installs PR_SET_PDEATHSIG before blocking on the private second-stage gate. The fork parent ignores SIGPIPE before sending the second-stage ready signal, so EPIPE on a vanished PID1 enters its existing exact-child kill/reap denial path rather than terminating the parent asynchronously.
- This remains a source-only diagnostic, not an independently attested launcher or a full task/revoke containment implementation.

## 2026-10-31 extra fail-closed source work
- The disposable Linux PID namespace helper now uses monotonic WNOHANG polling in BOTH normal and rejected gate paths; it kills/reaps **only its freshly forked test PID1** within 9s. A killed or unobserved child returns blocked (81/83/84), never success. The test PID1 cannot be a task worker.
- Source intent rejects embedded NUL in argv/task-root strings and bounds root path length. This is input-shape defense only, not Windows/Linux canonical file identity, symlink containment, or a native security permit.

## Parent-death fallback (31 Oct 2026)
- Direct disposable Linux diagnostic child now installs `PR_SET_PDEATHSIG(SIGKILL)` immediately after fork, before namespace setup, and compares `getppid()` with its recorded creator PID to close fork-to-prctl orphan races. This complements the separate PID1 parent-death signal. The test PID/group remain owned by the disposable probe, with no real Agent process, user task or privilege changes.
- Added source regression verifying parent identity and required ordering. Independent PID/cgroup kernel drain and real task containment are still NO-GO.

## Source argument-envelope negative (31 Oct 2026)
- AI-07 input-shape validator now bounds the **aggregate** `args` budget to 32767 UTF-16 code units with one separator per argument, rather than allowing 256 individually large strings. This conservatively rejects oversized Windows-style command-line input; native argv quoting/serialization still requires an independently verified frozen request digest and OS authorization, and cannot be inferred from JavaScript strings.
- Added targeted explicit `INVALID_TASK_INTENT` assertions for oversized single/multiple args, NUL argv and invalid task root. Not a replacement for kernel containment or a positive execution proof.

## Disposable parent-death kernel negative test (31 October 2026)
- New AI-07-owned `test/ai07-sandbox-linux-parent-death.test.ts` compiles a **test-only native fixture** on Linux and observes the exact spawned grandchild via PIDFD after parent exit. The fixture is subreaper-owned and reaped, with 8-second SIGALRM failsafe. A second compile intentionally removes parent-death fencing and requires a **blocked (exit 55)** result. No tasks, services, real users or production Agent are involved.
- Independently validated in isolated Linux 6.18.57 x86_64 / GCC 14.2 container: source compile `exit 0`, fenced fixture `exit 0` (5 repeated runs), disabled-fence negative control `exit 55`. This only tests **kernel parent-death signaling**, not namespaces/cgroup/WFP, worker privileges or whole process-tree revoke.

## Kernel fixture cleanup hardening (31 Oct 2026)
- The new disposable parent-death test itself now bounds outer fixture-parent `waitpid` to 3 seconds and fallback cleanup to 3 seconds, then performs PIDFD or exact-owned-child termination and bounded subreaper reaping on every negative/error path. No arbitrary host process IDs are ever signalled. Unreaped exact children produce nonzero BLOCKED status.

## Disposable Linux FD/seccomp kernel negatives (1 Nov 2026)
- Added `test/ai07-sandbox-linux-fd-seccomp.test.ts` with a test-owned native C fixture. `close_range(0..UINT_MAX)` closes all inherited descriptors (including stdio and a deliberately inherited `/dev/null` handle); narrow BPF seccomp allows only exit/exit_group/rt_sigreturn and requires EPERM on socket, openat and getpid. The process never connects to a network or executes a user task.
- Two deliberately broken compilation variants independently prove the negative checks reject: FD closure disabled (exit 53) and seccomp disabled (exit 55, only if the host supports harmless baseline syscalls). Unsupported host primitives fail BLOCKED, never simulated PASS.

## Test-owned environment leak negative and cleanup audit (1 Nov 2026)
- The disposable Linux FD/seccomp fixture now sets a synthetic child-inherited `NW07_TEST_ONLY_SENTINEL=FAKE_TEST_ONLY`; its forked test child must `clearenv()` before FD/seccomp checks. The deliberately disabled environment clear returns exit `59`. This tests only test-owned userspace environment clearing, **not** Windows/Agent protected credentials or a production identity.
- Clock failure/timeout paths now use an exact-owned child SIGKILL plus bounded WNOHANG reap helper; uncertainty returns BLOCKED. No outside PID, service or host security setting is modified.

## 2026-11-01 native PID1 pre-prctl parent-death gap
- A child in CLONE_NEWPID can observe an out-of-namespace parent as PID 0, so `getppid` is not reliable in namespace PID1. The direct diagnostic parent now opens `pidfd_open(getpid(), 0)` **before** forking; namespace PID1 inherits that exact parent handle, installs `PR_SET_PDEATHSIG(SIGKILL)`, then checks the pidfd with nonblocking `poll` both before and after the second-approval pipe gate. A dead/unknown parent fails with 87, unsupported pidfd fails 86, closure failure fails 88. No native task execution enabled.

## 2026-11-01 PIDFD early-orphan real kernel regression
- Added `test/ai07-sandbox-linux-pidfd-orphan.test.ts`. Disposable Linux test forks a parent that exits **before** its subject installs PR_SET_PDEATHSIG; inherited pre-fork self pidfd must report POLLIN. Guarded variant returns 0 with explicit BLOCKED marker; deliberately unguarded variant returns exit 55 and unsafe marker. No native Nexowire task, physical user token or production permission is involved.
