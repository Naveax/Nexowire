# AI-07 OS worker source contract
- All `task-os-sandbox-*` TypeScript routes remain **deny-only**; no test diagnostic grants an OS permit.
- Any untrusted report containing an own `mutationState` property, even `not_started`, getter, null, unexpected enum or `completed`, yields `RECONCILE_REQUIRED`. Never retry based on such input; independent durable CAS is required.
- Windows probe is **disposable VM diagnostic**, not a native task executor. Only accepts `--selftest-only`; reads its own effective elevation/AppContainer/IL, Job membership/breakaway flags and PID/creation FILETIME; no process creation, service changes, ACL/token mutation, network or client task input.
- A positive probe result is local/self readback, not independently protected identity evidence, no root filesystem or WFP/IP/IPC denial proof, no descendant containment, and no revoke drain.
- Existing Linux namespace/seccomp probe remains selftest-only. Unsupported OS fails closed.
- Production enabling requires AI-05's separate executor/CAS admission, AI-04's independent Broker/Job/receipt admission, AI-02 protected enrollment, AI-03 authenticated mTLS identity and AI-08 independent physical negative tests; OS-kernel observer evidence must be real, not mock booleans or stdout.


## 2026-10-31 continuation: hostile JS evidence handling
- `task-os-sandbox-policy.ts` now reads intent and OS report fields through own data descriptors rather than evaluating plain-object getters; malformed objects, sparse/hostile argv, environment symbols, and throwing Proxy prototype traps fail closed.
- Any malformed non-null report or own `mutationState` (including terminal-looking values) demands `RECONCILE_REQUIRED`, never replay. Inherited spoofing is rejected.
- This is still **source-only**. JavaScript Proxy reflection hooks are inherently executable; the true native trust boundary must authenticate serialized bytes and independent kernel readback outside the JS object graph.
- Added `test/ai07-sandbox-hostile-input.test.ts` negative tests. Do not equate unit tests with Windows AppContainer isolation.

- Revoked Proxy values in task/args/network/readback are never allowed to throw through the assessment path: all `Array.isArray` reflection is caught and yields invalid/blocked or reconciliation. No execution permit exists.

## Native diagnostic restrictions (2026-10-31)
- Linux disposable child has no inherited FD, including 0, 1, 2, before its seccomp fence; no write syscall is permitted after the fence. A passing marker comes from the probe's outer parent after waitpid/namespace observation, **never** from a child-emitted receipt. The diagnostic still has no cgroup v2 task lifecycle, independently protected attester, revoke, or user task execution.
- Windows probe requires observed primary token, AppContainer, low integrity, non-elevation, Job without breakaway and with KILL_ON_JOB_CLOSE; the flag is **not** a proof of whole-tree drain and doesn't establish guardian job ownership. No native launch/exec API is exposed.


## Bounded Linux diagnostic child lifetime
The outer parent bounds kernel namespace readiness to 5 seconds and own child reaping to 12 seconds by monotonic clock, then signals SIGKILL only to its exact forked diagnostic child; timeout is exit 78, never success. This is source-only containment of the *probe itself*, not a supported task revoke/descendant runtime.

## Cross-owner entrypoint (AI-07 remains deny-only)
```ts
// Implemented in AI-07, NEVER a permit to run:
executeSandboxRequiredCapability(
  capability: unknown,
  commandInput: unknown,
  sourceOnlyTaskIntent: unknown,
  untrustedReadback?: unknown,
): Promise<never>;
// It throws OsTaskSandboxBlockedError (code OS_TASK_SANDBOX_UNAVAILABLE
// or OS_TASK_RECONCILIATION_REQUIRED); legacy spawning is forbidden.
```
AI-05 must invoke the above **before** shell, process and nested task effects. AI-04 must independently check Broker-side OS/grant/CAS admission. Neither owner should infer permission from AI-07's synthetic probe status. AI-08's intentionally RED #832 cases remain unsatisfied by an API declaration alone.


## Native readback/source-only risk reduction
- Linux direct diagnostic child creates an isolated process group **before** unshare/fork. Timed-out parent checks exact child process group and kills it, and namespace PID 1 requests `PR_SET_PDEATHSIG`; exit remains nonzero on cleanup uncertainty. This is a bounded *selftest* improvement, **not** verified full descendant cleanup for arbitrary tasks or production grant release.
- Windows probe now reads effective `TokenAppContainerSid` and rejects missing/invalid SID, plus rejects `TokenUIAccess` even when `TokenIsAppContainer` is asserted. The token/Job checks remain local diagnostics, not independent permission, WFP, file or handle containment evidence.


### Bounded forced cleanup cannot claim completion on signal failure
A failure to signal the disposable Linux process group still attempts termination of its exact direct child. A bounded `waitpid(WNOHANG)` poll (5 seconds) is used after SIGKILL. An unobserved reap, group signal failure or child termination error produces BLOCKED and never authorizes revoke, quota release or execution.

### PID namespace / process-group diagnostic semantics
The outer source-only diagnostic requires `/proc/<probe-pid>/ns/pid_for_children` to differ from the host observer namespace, because unshare(CLONE_NEWPID) applies to subsequently forked children; the caller's `/proc/<pid>/ns/pid` is not sufficient. Parent also checks `getpgid(probe-pid)==probe-pid` before releasing the selftest barrier; a mismatch never permits signalling arbitrary host process groups. A post-seccomp `openat` must return `EPERM` (not mere ENOENT), independently of the mounted empty test root. These are unsigned test-program observations, not a secured OS grant or production worker identity.

### Correct two-stage namespace witness
`unshare(CLONE_NEWPID)` changes the namespace for future children only, and the kernel `pid_for_children` link may be empty until the first child exists. Therefore the separate `P` checkpoint only occurs **after** the disposable PID1 is forked. PID1 blocks on an O_CLOEXEC pipe gate until the external parent reads kernel namespace differences and replies `Y`; denial/EOF rejects the probe. Both readiness reads have bounded monotonic waits. This is a selftest-only unsigned parent/child handshake, not trusted production admission.

### Second-stage PID1 cancellation hardening
The disposable namespace init calls `prctl(PR_SET_PDEATHSIG, SIGKILL)` before waiting on its private `gate[0]`; the direct probe fork parent ignores SIGPIPE so a closed gate is an ordinary failed write and triggers its exact spawned-PID cleanup path. Neither POSIX process-group death nor these local barriers count as kernel-certified descendant drain for a real task.
