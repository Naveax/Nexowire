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
