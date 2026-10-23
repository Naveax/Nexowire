# #780 / new team #07: task OS sandbox provider and physical acceptance contract

**Date:** 2026-10-24 (Europe/Istanbul). **Owner:** #07, sandbox policy/provider and task-scoped trust boundary only.
**Read baseline:** `main 754cc4364822be5fda528f54042fb22a84f19924`.
**Decision:** **BLOCKED / NO-GO**. This document is an executable-provider integration specification, not a native provider, task execution permission, test waiver, or signed HIGH Broker.
**Coordination:** #539, product epic #780. #02 owns Windows ProcessManager, native Job, signed HIGH Broker OS witness. #01 owns journal/CAS. #03 owns artifacts and trusted filesystem publishing. #04 owns grants/owner epoch. #06 owns Git/shell executor integration.

## 1. Exact source inventory and negative evidence

| Actual path | Observed code | Security classification |
| --- | --- | --- |
| Headless `shell.exec` | `src/agent/executors.ts:342-359,432-452,2296-2297`: `runProcess` calls ordinary Node `spawn`, passes `env: process.env`, optional `cwd`; `terminateProcessTree` signals only immediate POSIX child or starts asynchronous Windows `taskkill` | **UNCONFINED**. A checked cwd does not limit filesystem, sockets, env, children, hooks or inherited handles |
| Existing file allowlist | `src/agent/path-policy.ts:27-118`: pathname/realpath preflight and nearest existing ancestor | For supported file APIs only; **NOT** an OS process root |
| Windows process.start | #829 native Job source and CI `39863445519` SUCCESS; #788/#793 process-owner reviews | Validates selected Windows Job lifecycle/output, **NOT** per-task restricted token, root filesystem, secrets or network |
| Read-only preflight | #782 `src/diagnostics/task-sandbox-readonly-preflight.ts` always returns `dispatchAllowed: false`, `processIsolation: 'NOT_PROVEN'` | Advisory untrusted inventory; cannot promote reported flags to execution authority |
| FileID + volume | #707 source evidence for file API root identity | Not a shell or descendant OS sandbox |

**Independent #832** HEAD `3010885c2a4dd4d8c66df574bfb758fe9170f220`, CI `39863614267`, Node 22 job `120120180991` **FAILURE**: exactly eight physical-effect negatives observed on the Linux CI runner. The eight are: sibling TEMP file access/write, ambient synthetic env marker, child escape, symlink, hardlink, Git post-commit helper, loopback TCP/UDP/DNS-wire, orphan after timeout. This does **not** prove those eight were separately executed on Windows. Other five jobs succeeded, Node 24 was cancelled; no source or OS acceptance PASS. Preserve #832 unchanged until a real boundary resolves these checks.

**No unique additional negative is responsibly runnable now:** #832 already covers the current actual shell effects. #782 separately covers absent/forged read-only providers. The next uncovered, physically meaningful tests need an actual restricted-token/namespace provider: *inherited pre-opened OS file handle, cross-process handle duplication/SCM_RIGHTS, and network/child restriction from the actual task token*. A pure/mock “PASS” or another duplicate RED test would not improve enforcement.

## 2. Provider API: separate preparation, suspended launch, attestation, resume

The following is a **target contract**, not a new runtime symbol. Only a native trusted launcher and independent readback may ever authorize task execution. JS caller reports, booleans from #782, environment flags, UI modes, request metadata and unverified source CI are not admission proofs.

```ts
type SupportedOs = 'win32' | 'linux' | 'darwin';
type Backend =
  | 'win32-appcontainer-restricted-token-job'
  | 'linux-user-mount-pid-netns-cgroup'
  | 'darwin-verified-vm';

interface TaskLaunchIntent {
  readonly schema: 1;
  readonly platform: SupportedOs;
  readonly taskId: string;
  readonly originalRequestId: string;   // immutable logical mutation
  readonly ownerId: string;
  readonly ownerEpoch: number;           // externally fenced, never caller trusted
  readonly deviceId: string;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly baseWorktreeSha: string;
  readonly taskRoot: {
    readonly canonicalPath: string;
    readonly volumeOrMountIdentity: string;
    readonly rootFileIdOrInode: string;
  };
  readonly externalRoots: readonly { // separately signed, scoped, time-bounded
    readonly identity: string;
    readonly access: 'read' | 'write';
    readonly grantId: string;
  }[];
  readonly executableDigest: string;
  readonly args: readonly string[];     // no implicit host shell interpretation
  readonly envAllowlist: Readonly<Record<string, string>>;
  readonly network: { readonly default: 'deny'; readonly allowedEndpoints: readonly [] };
  readonly budgets: {
    readonly cpuMs: number;
    readonly wallMs: number;
    readonly memoryBytes: number;
    readonly maxProcesses: number;
    readonly outputBytes: number;
    readonly diskBytes: number;
  };
}

interface TrustedTaskSandboxProvider {
  // Must not run task code while resolving paths, grants or resource limits.
  prepare(intent: TaskLaunchIntent): Promise<PreparedScope>;
  // Launch with OS restrictions already installed, suspended until verified.
  launchSuspended(prepared: PreparedScope): Promise<SuspendedScope>;
  // Two independent, concrete witnesses: OS kernel identity and host policy.
  attest(suspended: SuspendedScope): Promise<KernelPolicyReceipt>;
  // Trusted host gate checks attestation + owner grant + off-host CAS again.
  // Resume exactly once for originalRequestId. Never accept a caller-supplied
  // KernelPolicyReceipt as authority.
  resumeVerified(suspended: SuspendedScope): Promise<RunningScope>;
  observe(scopeId: string): Promise<ScopeObservation>; // immutable process identity
  stopAndDrain(scopeId: string): Promise<DrainReceipt | UnknownReceipt>;
  reconcile(originalRequestId: string): Promise<ScopeObservation | UnknownReceipt>;
}
```

The `PreparedScope`, `SuspendedScope`, `KernelPolicyReceipt`, `RunningScope`, `DrainReceipt` and `UnknownReceipt` are **opaque trusted-native handles/receipts** bound to one process identity and launch generation, not structural objects injected by remote JSON or a test flag. No arbitrary `provider.isReady=true` interface. Provider execution may only be integrated by the #06/#02 owners after a separate trusted verifier exists. A configuration string or a library declaration never enables dispatch.

### Invariants checked by trusted admission

1. **Before first instruction:** independently verify signed request owner/device/grant/generation, external monotonic owner epoch/CAS (#01/#04), task root pinned identity and versioned SHA; root handle and all explicitly exposed mounts are retained. Failure before any possible resume: `OS_SANDBOX_UNAVAILABLE` / `DENIED`. If resume may have happened but an ACK/readback is lost: `MUTATION_STATE_UNKNOWN` / `RECONCILE_REQUIRED`, **never replay**.
2. **Task filesystem:** mount/ACL only an isolated writable task root and explicitly granted file identities; toolchain/code readonly; all output staged. Do not expose ambient user's home, credentials, privileged sockets, Agent files, or a shared writable original worktree. Reject symlink/reparse/ADS/hardlink aliases and stale source file IDs. Handle-relative no-follow access and final publication are separately #03-owned; a copied worktree must not preserve writable cross-boundary hardlinks.
3. **Process identity and descendants:** verify OS token/UID/GID/namespace and live kernel Job/cgroup/VM scope *after* launch and before resume; no unintended inheritable handles or descriptors, no breakaway, privilege escape, ambient Agent credentials, or host shell fallback. All direct and indirect Git hooks/scripts inherit the boundary. Process count, CPU/memory, wall timeout and output budgets actually enforced.
4. **Network and IPC:** default deny for both families, DNS over UDP/TCP, direct IP, loopback and IPC access to Agent/Broker; policy must follow child/grandchild and survive resets. Environment `HTTP_PROXY`, proxy removal or an absent NIC string is not an egress firewall. Allow rules must be separately signed, scoped and kernel-enforced.
5. **Stop/cleanup:** close task-owned handles, stop entire descendant tree, inspect kernel scope again; do not report `DRAINED` on an unconfirmed stop, surviving Job reference, leaked cgroup task, VM guest, or lost observer. Quota/lease release waits for independently observed drain. Unknown state requires durable reconciliation.
6. **HIGH boundary:** CORE/ROOT never inherit automatically into sandbox. Privileged work must leave through #02's **separate installed signed HIGH Broker** and #04's explicit owner grant, independently fenced by #01. Sandbox IPC cannot invoke an ambient privileged endpoint merely because it is loopback/local.

## 3. Per-OS provider choice and failure contract

| Target | Smallest credible provider | Mandatory witness | Current status |
| --- | --- | --- | --- |
| **Windows** | Verified restricted primary token/AppContainer identity + **native #02 Job** before resume; scoped task-root ACL, no inherited privileged handles; separately enforced AppContainer/WFP rules for zero TCP/UDP/DNS/loopback and Broker IPC | `TokenIsAppContainer` / AppContainer SID, integrity/restricted SIDs, token effective file AccessCheck with *actual task principal*; PID+creation FILETIME, Job limits/member evidence, protected guardian/job handle DACL, low-user `PROCESS_DUP_HANDLE` DENIED; independent WFP/network denials and descendants | **BLOCKED**. Job source alone proves none of filesystem/network/token conditions |
| **Linux** | Rootless user+mount+PID+network namespaces with isolated worktree copy/overlay; cgroup v2 lifetime/resource limits and seccomp/LSM as threat model requires; no network interface/host socket; no inherited host FDs | Host `/proc/<pid>/ns/*`, `uid_map`, mountinfo, cgroup identity and descendant enumeration checked against retained namespace FDs; actual disallowed filesystem/hardlink/inherited-FD and TCP/UDP/DNS/loopback probes | **BLOCKED** if namespace creation, mount isolation, cgroup or independent network denial is unavailable. Do not fallback to `chroot`/cwd/docker CLI flag alone |
| **macOS** | Separately instantiated, resource-bounded native VM with **no NIC**, explicitly limited file sharing and unique guest identity; host verifies guest lifecycle and boundary. Alternative native sandbox approach needs separately proven maintained OS enforcement | Actual hypervisor guest identity, absence of NIC/host sockets, scoped shared filesystem and no unapproved host file access, descendants and termination, clean guest env; independent external negative QA | **BLOCKED**. GUI sandbox, `sandbox-exec` command availability or a normal POSIX child is not sufficient proof |

These are *choices*, not claims of currently installed availability. If a platform cannot meet every required dimension, return a precise `UNSUPPORTED_OS_BOUNDARY` or `OS_SANDBOX_PROVIDER_UNAVAILABLE`; **do not silently degrade** to caller-privilege `spawn`, a private desktop, a Windows Job without token/network policy, unsandboxed `git`, or a mock.

## 4. Non-delegable integration order, owners and acceptance

1. **#07 provider:** implement native-independent immutable task-scope policy, provider/backend selection, default-deny network/env/FS parameters; independent attestation verifier. All externally visible statuses remain `BLOCKED` until verified kernel launch receipt exists.
2. **#03 artifact/root owner:** provide filesystem root identity, protected copy/overlay policy and safe final publication; hardlink/reparse/stale identity and disk budget tests. A `PathPolicy` report cannot become kernel authority.
3. **#02 Windows native owner:** supply suspended restricted-token/AppContainer+Job actual launch, protected handles, kernel readback/stop/drain; **no signed HIGH Broker token within task**.
4. **#01/#04:** external owner epoch/grant CAS and lease fencing, signed intent and rollback-independent `UNKNOWN` receipts.
5. **#06 coding executor:** exclusively integrate trusted admission into `shell.exec`, Git/subprocess paths and durable workers. All task execution paths must either pass trusted admission or be explicitly classified **legacy unconfined** and disallowed for sandbox-required tasks.
6. **#10/#11 independent QA:** rerun **unchanged** #832 eight negatives against the *real provider path* on each OS; add physical inherited-handle and cross-process handle/FD passing tests, token/network/child/stop/lost-ACK proof. Verify both safe positives and denied negatives on exact executable and Git SHA; existing #782 source-only inventory stays advisory.
7. **#12 integrator / #00:** acceptance requires exact PR source SHA, no duplicate already-active workflow, green source CI, native physical kernel evidence and explicit OS/platform receipts **separately**. No main merge or automatic production activation.

**Minimum acceptance statuses:** `SOURCE_ONLY` (code/test validated) != `HOSTED_CI_PASS` != `NATIVE_PHYSICAL_BOUNDARY_VERIFIED` != `PRODUCTION_ACCEPTED`. Presently the only truthful task-OS-sandbox status is **BLOCKED / NO-GO**.

**This #07 review does not run task shell, network probes, local Git hooks, VM, live Agent/Broker/UAC/ACL, cloud or personal-file operations.** #832 provides historical hosted CI physical-effect observations; this handoff neither replays nor weakens those failures.
