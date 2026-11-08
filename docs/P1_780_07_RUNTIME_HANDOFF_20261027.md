# Nexowire #07 | OS worker handoff to #03 | 2026-10-27

**STATUS: SOURCE-ONLY/DIAGNOSTIC; production execution BLOCKED.** This handoff is a dependency contract, **not** an authorization to merge or deploy.

## Exact current boundary

The active Agent dispatcher in \`src/agent/executors.ts\` is still owner #03. It dispatches \`shell.exec\` via \`executeShell\` and \`runProcess\`, currently using Node \`spawn\` with \`env: process.env\`; \`process.start\`, \`wsl.exec\`, \`task.graph.run\`, \`runbook.run\`, \`workspace.checks\` and \`workspace.snapshot\` expose other process effects. The existing #07 source API alone **does not intercept any of these**. An existing Job Object and generic workspace \`PathPolicy\` are not an OS sandbox.

The owner #03 can immediately integrate the **non-executing** gate:

\`\`\`ts
import { executeSandboxRequiredCapability } from './task-os-sandbox-capability.js';
// Before ANY subprocess or nested action that requires OS isolation:
return await executeSandboxRequiredCapability(
  capability, request, scopedTaskIntent, untrustedObservedStatus,
);
// At present this always throws OS_TASK_SANDBOX_UNAVAILABLE, or
// OS_TASK_RECONCILIATION_REQUIRED for ambiguous mutation outcomes.
\`\`\`

\`prepareSandboxRequiredCapability\` supplies safe audit metadata; **never** use it as a launch permit. It explicitly returns \`launchAllowed:false\`, \`mayFallbackToLegacySpawn:false\`, \`canRetryAfterUnknown:false\` and \`runtimeIntegratedIntoAgentDispatch:false\`. The input may contain a forged signature or native success flag: neither is accepted. #03 must guard **all** synchronous/asynchronous effects before calling \`runProcess\`, \`runWindowsPrivateShell\`, process session start, direct WSL and nested task/runbook operations. Do not rely solely on an outer task graph check.

## OS implementations and what's really demonstrated

- **Windows:** no accepted native restricted token/AppContainer/Job plus OS-backed ACL/egress provider in #07. #02 owns Broker/Job; do not copy its guardian or treat its \`KILL_ON_JOB_CLOSE\` as privilege/network/filesystem proof. Windows remains BLOCKED.
- **Linux:** \`native/task-os-sandbox-linux-namespace-probe-p07.c\` is **only** a disposable \`--selftest-only\` program. It can call real kernel \`unshare\` for user/mount/net/IPC/UTS/PID namespaces, map inner uid/gid, privatize mounts, pivot into noexec/nosuid tmpfs, reject outside-root reads, erase ambient environment, close all fds >=3 with \`close_range\` (no finite-FD loop), enable \`PR_SET_NO_NEW_PRIVS\`, and install an **architecture-checked seccomp-BPF default-deny** filter allowing only write/exit/rt_sigreturn/getpid/getuid. It actively asserts that creating a TCP socket gets \`EPERM\`. **No argv-driven shell or task launch.** An outer parent **within the same unsigned program** now reads kernel `/proc/<pid>/ns/{user,mnt,net,ipc,uts}` inode identities and `uid_map` through a pipe-and-resume barrier; missing/mismatched readback refuses resume. This is process-separated kernel evidence, **not** a separately trusted, signed or protected production observer. The `CLONE_NEWPID` PID1 check covers only the diagnostic process, not arbitrary descendants. \`cgroup v2\` delegation/budgets, full inherit-FD/SCM_RIGHTS, complete descendant and revoke drain, independent host namespace readback, and physical installed-Agent tests are still missing. Fail closed on any unavailable syscall or non-zero diagnostic exit; never promote stdout to authorization.
- **macOS:** VM guest identity, no shared host filesystem, no network/host IPC and verified kill/revoke are unimplemented; BLOCKED.

## Native admission contract before any user task execution

1. #01/#04 independently reserve monotonic owner/device/session/grant epoch via rollback-resistant external CAS. A token/lease or any test fixture is never enough. On revoke, stale epoch, lost ACK, \`UNKNOWN\` or timeout, **no new dispatch, no automatic replay, no premature quota release**.
2. Provider #07 prepares root suspended, pinned executable digest and task root file ID; constrains a *standard low-privilege* OS identity and deny-by-default FS/network/IPC, no ambient credentials/env/privileged handles. Verify Windows restricted primary token/AppContainer SID, kernel integrity, process DACL and \`PROCESS_DUP_HANDLE\` denial, Job/breakaway/nested Job and child containment; Linux mount/user/pid/net namespace identities, cgroup v2, seccomp+LSM and inherited FDs; macOS isolated guest identities.
3. **Independent** kernel observer not controlled by the task must bind exact root PID+creation timestamp, signed native helper hash, effective token/UID, cgroup/Job membership, mount/fs root, network deny and descendant coverage to the reserved request+epoch. Recheck grant and proof **after all awaits, immediately before release from suspended state**.
4. Revoke stops admissions first, then terminates entire trusted containment scope; independent observer must confirm no descendants, privileged handles, sockets or escaped effects before reporting \`cleanupVerified\` or releasing resources. If observer dies or results are ambiguous: \`RECONCILE_REQUIRED\` permanently until a separate durable reconciliation succeeds.

## Adversarial physical acceptance (cross-team, not this PR)

Retain #832's unchanged eight RED negatives against real \`executeCapability('shell.exec')\`: sibling-root read/write, synthetic env, descendants, symlink/junction and hardlink identities, Git hook, TCP/UDP/DNS loopback, timeout orphan. Add Linux cgroup escape/host fd/SCM_RIGHTS, Windows same-HIGH PROCESS_DUP_HANDLE/SeDebug/SYSTEM, nested jobs/COM/service bypass, revoked epoch/lost-ACK/restart/long soak. A \`7/7\` hosted GitHub CI result is a **source test** result, not the signed installed-Agent and independent hardware/OS denial evidence.

**Ownership:** #07 files only here; #02 Job/Broker and #03 dispatcher remain untouched. No device/VM (including ReVoltVPN-Ubuntu-Lab), service/UAC/ACL, or deploy/merge action.
