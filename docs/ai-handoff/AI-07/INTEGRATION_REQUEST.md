# AI-07 integration request
AI-07 did **not** edit `src/agent/executors.ts`, Broker, package.json, workflows, or services.
1. **AI-03:** Guard every `shell.exec`, `wsl.exec`, `process.start`, `task.graph.run`, `runbook.run`, `workspace.checks`, `workspace.snapshot` and indirect/nested `runProcess` before effects. Use deny-only `executeSandboxRequiredCapability()` and propagate `OsTaskSandboxBlockedError`. No fallback to ambient `spawn` if denied.
2. **AI-05/native provider:** Future suspended low-privilege worker, independently observed exact PID/FILETIME, effective restricted token/AppContainer/Job boundary, no inherited secrets/handles, filesystem/network/IPC enforcement. Current probe cannot serve as permit.
3. **AI-02:** Separate Broker admission, monotonic external CAS, owner/device/session epoch, signed scope, irreversible UNKNOWN/lost ACK quarantine.
4. **Revoke owner:** Whole process/descendant and FD/handle/IPC drain under kernel witness before resource escrow release; nested Job/breakaway and Linux cgroup tests.
5. **CI coordinator:** Disposable Windows VM+MSVC test and independent negative file/network/descendant/handle tests separately from source CI. Never mark synthetic green as physical containment.

## Coordinator CI verification request
- In an **isolated Windows runner** with native MSVC environment, compile `native/task-os-sandbox-windows-appcontainer-probe-p07.c` with `cl /W4 /WX` (Advapi32 linked via pragma); invoke with invalid args and expect exit 64, and in an unprivileged non-AppContainer process with `--selftest-only` expect 77. A truly AppContainer Job selftest requires an independent test harness, not host Agent execution. Do not mark absent native execution PASS.
- On disposable Linux namespace-capable container/VM run opt-in `NW07_RUN_NATIVE_NAMESPACE_PROBE=1` separately; unsupported namespace/close_range returns BLOCKED, never a fake PASS. Independently verify kernel isolation, inherited file descriptors, child process and cgroup drain; no task executable is permitted by this diagnostic.
