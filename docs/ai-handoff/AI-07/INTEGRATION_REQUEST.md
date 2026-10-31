# AI-07 integration request
AI-07 did **not** edit `src/agent/executors.ts`, Broker, package.json, workflows, or services.
1. **AI-03:** Guard every `shell.exec`, `wsl.exec`, `process.start`, `task.graph.run`, `runbook.run`, `workspace.checks`, `workspace.snapshot` and indirect/nested `runProcess` before effects. Use deny-only `executeSandboxRequiredCapability()` and propagate `OsTaskSandboxBlockedError`. No fallback to ambient `spawn` if denied.
2. **AI-05/native provider:** Future suspended low-privilege worker, independently observed exact PID/FILETIME, effective restricted token/AppContainer/Job boundary, no inherited secrets/handles, filesystem/network/IPC enforcement. Current probe cannot serve as permit.
3. **AI-02:** Separate Broker admission, monotonic external CAS, owner/device/session epoch, signed scope, irreversible UNKNOWN/lost ACK quarantine.
4. **Revoke owner:** Whole process/descendant and FD/handle/IPC drain under kernel witness before resource escrow release; nested Job/breakaway and Linux cgroup tests.
5. **CI coordinator:** Disposable Windows VM+MSVC test and independent negative file/network/descendant/handle tests separately from source CI. Never mark synthetic green as physical containment.
