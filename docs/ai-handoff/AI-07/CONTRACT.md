# AI-07 OS worker source contract
- All `task-os-sandbox-*` TypeScript routes remain **deny-only**; no test diagnostic grants an OS permit.
- Any untrusted report containing an own `mutationState` property, even `not_started`, getter, null, unexpected enum or `completed`, yields `RECONCILE_REQUIRED`. Never retry based on such input; independent durable CAS is required.
- Windows probe is **disposable VM diagnostic**, not a native task executor. Only accepts `--selftest-only`; reads its own effective elevation/AppContainer/IL, Job membership/breakaway flags and PID/creation FILETIME; no process creation, service changes, ACL/token mutation, network or client task input.
- A positive probe result is local/self readback, not independently protected identity evidence, no root filesystem or WFP/IP/IPC denial proof, no descendant containment, and no revoke drain.
- Existing Linux namespace/seccomp probe remains selftest-only. Unsupported OS fails closed.
- Genuine production enabling requires #02/#03 coordination, externally authenticated grants and OS-kernel observer; never replace this contract with mock booleans or stdout.
