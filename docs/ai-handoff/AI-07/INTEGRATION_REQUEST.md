# AI-07 integration request
AI-07 did **not** edit `src/agent/executors.ts`, Broker, package.json, workflows, or services.
1. **AI-05 (CAS/executor/dispatcher owner):** Guard every `shell.exec`, `wsl.exec`, `process.start`, `task.graph.run`, `runbook.run`, `workspace.checks`, `workspace.snapshot`, and all indirect/nested `runProcess` paths before any side effect. Integrate the **currently deny-only** `executeSandboxRequiredCapability(capability, commandInput, sourceOnlyTaskIntent, untrustedReadback?) : Promise<never>` and propagate `OsTaskSandboxBlockedError`. Do not fall back to ambient `spawn`. Integrate immutable request snapshot and lost-ACK/UNKNOWN handling with the owner's external CAS. An adapter import without an actual pre-effect call does not fix #832.
2. **AI-04 (Broker admission / Job / receipt owner):** Implement a separate trusted Broker-side admission gate and signed native OS receipt, binding owner/device/session + grant epoch, immutable request digest, exact native PID/creation identity, and kernel-enforced process lifetime. Windows Job membership or unsigned local output alone is not acceptance. AI-07 does not change the Broker or Job implementation.
3. **AI-02 (enrollment/protected local Windows Service owner):** Provide genuine machine-bound enrollment and independently protected credential/secret-storage boundary without fabricating local approval, effective CORE, or privileged child token. No direct work by AI-07 in these modules.
4. **AI-03 (mTLS/verifier owner):** Provide authenticated transport, pinned identities and revocation/expiry verification. A valid mTLS session is not proof of native worker isolation or authorization to execute.
5. **AI-07 native provider handoff:** Future suspended low-privilege worker with independently observed exact PID/FILETIME, restricted token/AppContainer or Linux namespaces+cgroups, no inherited credentials/handles, filesystem/network/IPC enforcement and verified revoke-and-drain. The current Windows/Linux source-only probes cannot serve as permits or real task executors.
6. **AI-08/CI coordinator:** Independently retain #832 RED negatives and test exact installed signed binaries, direct IP/TCP/UDP/DNS/loopback, path escape, child/grandchild, inherited handles/env and revoke/UNKNOWN. Coordinator alone owns shared workflow/integration changes. Never mark synthetic green as physical containment.

## Coordinator CI verification request
- In an **isolated Windows runner** with native MSVC environment, compile `native/task-os-sandbox-windows-appcontainer-probe-p07.c` with `cl /W4 /WX` (Advapi32 linked via pragma); invoke with invalid args and expect exit 64, and in an unprivileged non-AppContainer process with `--selftest-only` expect 77. A truly AppContainer Job selftest requires an independent test harness, not host Agent execution. Do not mark absent native execution PASS.
- On disposable Linux namespace-capable container/VM run opt-in `NW07_RUN_NATIVE_NAMESPACE_PROBE=1` separately; unsupported namespace/close_range returns BLOCKED, never a fake PASS. Independently verify kernel isolation, inherited file descriptors, child process and cgroup drain; no task executable is permitted by this diagnostic.


## AI-07 Windows native test handoff
Coordinator should run `node --test --import tsx test/ai07-sandbox-windows-msvc-p07.test.ts` in an isolated Windows runner with VS C++ tools and record its exact HEAD. This is a safe native compilation/negative-CLI probe only, not a security authorization test and not evidence of AppContainer/SID/root/egress isolation. Shared `.github/workflows/**` is coordinator-owned: AI-07 does **not** edit workflows.


## Native cleanup and token identity follow-up
- AI-04/AI-05 cannot treat the source-only Linux test's process-group kill as durable process-tree cleanup: real worker children may break away, cross groups, inherit handles, and affect external CAS; require independent cgroup/Job/namespace readback, no unreaped descendants, and escrow fencing before releasing grants.
- AI-08 negative QA should check parent death while namespace PID 1 is alive, child breakaway, inherited descriptors 0/1/2, and missing AppContainer SID or UIAccess. The test-only probe does not authorize production worker launch.

### Independent PID namespace evidence and FS negative
AI-08 should verify real `pid_for_children` namespace identity from the kernel outside the worker, and distinguish `EPERM` syscall denial from merely absent path. AI-05/AI-04 must never treat a successful unsigned namespace diagnostic as a grant, Job/CMF ownership, protected handle readback or permission to execute. Real cgroup task descendant drain and filesystem/network IPC negative remain separate acceptance blockers.

### Genuine Linux parent-death test availability
Coordinator/AI-08 can separately run `node --test --import tsx test/ai07-sandbox-linux-parent-death.test.ts` on disposable Linux kernel with pidfd and subreaper support. Fenced run must exit 0, deliberately disabled fence must exit 55; failure to support these primitives is BLOCKED, not PASS. This does **not** discharge isolated task filesystem/network/cgroup/credential or revoke evidence, or authorize CORE launch.

### AI-07 FD/seccomp negative handoff to AI-08/coordinator
Run the exact-head `test/ai07-sandbox-linux-fd-seccomp.test.ts` on isolated disposable Linux runners, and retain all three variants: protected exit 0, disabled FD closure exit 53, disabled seccomp exit 55. These are narrow real-kernel negative checks; they do **not** establish production user/owner identity, task root containment, inherited Broker handles/credentials, cgroup process tree drain or signed grant admission. Preserve independent AI-04/AI-05 gates, CORE off and Draft/NO-GO.

### AI-08 independent parent-orphan test
Run disposable Linux test of direct parent death *before* namespace PID1 installs `PR_SET_PDEATHSIG`. Observe inherited exact-parent pidfd becomes POLLIN and the probe returns BLOCKED (87); do not accept getppid() == 0 as an alive parent. Missing kernel pidfd support must remain UNSUPPORTED/BLOCKED. The current pidfd observation is in an unsigned source-only diagnostic and is **not** a protected verifier, cgroup drain proof or native task permit.

### File-root admission gap: openat2 is not hardlink confinement
AI-04/05 must not treat `openat2` RESOLVE_* alone, `st_nlink`, a canonical path string, or a synthetic negative fixture as full filesystem isolation. Require trusted root mount/inode identity, durable immutable request binding and an OS-protected file access boundary with hostile link/hardlink/rename/race acceptance. AI-08/coordinator can independently run `test/ai07-sandbox-linux-openat2-root.test.ts` (expected exit 0 / 55 / 56 / 57) on disposable Linux; no tests require a live machine or privileged Agent.

### Non-authoritative JS envelope hardening for AI-04/05
AI-07 now validates the complete own-key schema of source intent, including root/network/budgets and endpoint array hidden metadata. Do not use JS reflection as a native security proof: proxies, async mutation and serializer differences still require a frozen canonical native request byte buffer, signed capability/fingerprint identity and independent CAS/Broker gate before **any** side effect. There is no runtime permit in this PR.

### P0: group kill cannot stand in for kernel-enforced descendant drain
AI-04/AI-05/AI-08 must preserve the negative `test/ai07-sandbox-linux-setsid-breakaway.test.ts`: POSIX `setsid` can escape a process group and survive `kill(-pgid,SIGKILL)`, even when the direct parent is reaped. Do NOT release grant/quota or claim worker cleanup from a Job flag, group kill, single waitpid or synthetic receipt. Require independently verified cgroup v2 process membership/killed population, exact worker identity and revoke readback (or protected Windows whole-Job containment), with UNKNOWN remaining terminal until durable reconciliation. Source-only AI-07 does not modify executor/Broker.
