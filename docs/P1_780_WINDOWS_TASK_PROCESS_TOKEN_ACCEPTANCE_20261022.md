# #780: Minimal Windows task launch acceptance, Job vs restricted token/AppContainer

**Owner:** #03 ProcessManager / Windows Job. **Scope:** source review and integration requirements only.
**Exact parent:** #788 `7927adefbbefb33e578cf85471a2e516544a91da` (full CI `39817363480`: **7/7 SUCCESS**).
**Date:** 2026-10-22. **Production status:** P1 task sandbox **NOT IMPLEMENTED**; signed HIGH Broker **P0 NO-GO**.
No native code, ACL, service, Broker, UI consent, task/VM or process was changed by this review.

## 1. Actual source execution paths and ambient authority

| Entry | Exact source and observed dispatch | Ambient rights / escape risk | Accepted security claim |
| --- | --- | --- | --- |
| Headless `shell.exec` | `src/agent/executors.ts:342-359,436-452`: `runProcess -> spawn`, `env:process.env` | Inherits calling Windows identity, environment, filesystem/network permissions. An optional `cwd` is canonicalized, but no Windows Job, restricted token, AppContainer, network filter or task root is applied | **Unconfined command execution; NOT Job or task sandbox** |
| Volatile `process.start` | `src/agent/process-manager.ts:1022-1105`: `launchWindowsJob(...env:process.env)` on Windows | Real suspended root and verified unnamed Job; still inherits ambient environment and OS token. No network namespace, signed root grant or constrained file handles | **Verified Job root membership/lifetime ONLY**, not filesystem/network isolation |
| Durable `process.start` | `src/agent/process-manager.ts:805-878`: detached process worker, `env:process.env` | Separate worker first starts without a task-scoped restricted/AppContainer token; per-task Job lifetime and descendants cannot be inferred from volatile launch | **Durable process management, NOT OS sandbox** |
| GUI private shell | `src/agent/windows-private-shell.ts:111-127,146-187` | Explicit environment allowlist for private desktop; still the user's OS identity/network/filesystem permissions | **GUI routing, NOT an OS security compartment** |
| Workspace checks and Git/hooks | `src/agent/executors.ts:1041-1059,1360-1409,2063-2115` | Git worktree may refer to external gitdir, config, attributes and hooks. Check runner calls `runProcess`, not restricted task execution. Hook execution depends on invoked Git command/config, not merely status | **No per-task hook/child network/secret isolation** |
| File API PathPolicy | `src/agent/path-policy.ts:27-118` | Canonical pathname preflight for supported file calls; does not limit a spawned process's syscalls or prevent a child from accessing paths outside the allowlist | **App-level path checks, NOT a sandbox** |

**Practical conclusion:** every command/script, child process or hook spawned through
headless/durable/unrestricted paths can inherit whatever rights the Agent's
own Windows token/environment and OS allow. `cwd` alone does not restrict
file reads, writes, raw sockets, DNS, loopback, IPC or credentials. A network
request is possible in principle; this source review did not run live egress.

## 2. #786 independent Git worktree-root RED, including #788 lineage

- QA owner #26 [DRAFT #786](https://github.com/Naveax/Nexowire/pull/786), HEAD
  `8d5390dc8ed94e13ac380c6e37aa6f4de2888d4b`,
  hosted `39817020745`: Node22 **FAILURE** (deliberate security negative),
  Node24 CANCELLED; five remaining jobs SUCCESS. Do not call it a passing
  production test or merge a red negative.
- Byte-for-byte unchanged QA26 test blob:
  `866c12289db344ef72d6c3a63112228c970aa0b9`.
  Replayed on #788 source in an isolated test-only worktree: **0 PASS / 1
  FAIL / 0 SKIP**, exact error **"Missing expected rejection: Git-discovered
  root outside the approved task scope must fail closed."** Neither QA test
  nor product source was edited; test setup uses disposable local Git
  linked worktree under TEMP and disables hooks.
- Key distinction: `workspace.detect` already re-authorizes the discovered
  root via `policy.resolveExisting(resolved.root)` in
  `executors.ts:1088-1102`; however `workspace.snapshot` checks only
  the **requested** cwd at `executors.ts:2068`, then runs Git queries and
  directly does `fs.readdir(rootResult.stdout.trim())` at
  `executors.ts:2069-2097`. Thus **snapshot is still vulnerable** at
  the #788 source snapshot. The checked `detect` path does not repair
  the distinct `snapshot` path.
- **Owner boundary:** #05 workspace/file sandbox or assigned workspace
  owner should independently preserve QA26 unchanged, authorize
  Git-discovered root (and separately audit linked worktree
  `.git`/gitdir/commondir) *before* any out-of-scope filesystem
  read or derived workspace check. Git hooks/config inheritance and
  Git command execution must not be promoted to "sandboxed" without an
  OS process policy. **#03 will not overwrite this cross-owner code.**

## 3. Minimal physical acceptance matrix: Job vs restricted token vs network

| Property | Windows Job (current #03) | Restricted token / AppContainer (future) | Required physical acceptance |
| --- | --- | --- | --- |
| Start and stop | `CreateProcessW(CREATE_SUSPENDED)`, `AssignProcessToJobObject`, kernel Job membership, PID creation FILETIME; guardian lifetime | Token/AppContainer identity applied **at process creation**, before root resume; never elevate within sandbox | Independently check exact process token SID, integrity RID, restricted groups / AppContainer SID; root + tested descendants match signed task grant |
| Handle containment | Unnamed Job, `KILL_ON_JOB_CLOSE` | Restricted task account/process DACL, no inheritable privileged handles | **Low-user `OpenProcess(PROCESS_DUP_HANDLE)` DENIED** against actual protected guardian; Job handle duplication denied; retained-handle / guardian crash cannot keep task running unaccounted |
| Filesystem | Job does not create root-only filesystem view | Real restricted file ACL + #05 handle-rooted task file APIs/grants; AppContainer capabilities where appropriate | Outside-root file/dir/registry denial from same actual task token, including linked worktree, reparse/ADS/hardlink, rename race, Git hooks; no bypass via inherited handles |
| Network | **No egress policy** provided by Job | AppContainer/WFP or an equally proven OS enforcement tied to task identity and grant | Explicit negative DNS, direct-IP TCP/UDP, loopback, named pipes/IPC; verify default-deny before running task and no privilege escalation through allowed broker IPC |
| Environment/secrets | Standard shell + volatile/durable worker pass `process.env` | Per-task allowlist, no Agent bearer tokens, no credential handles/ambient access | Child + Git hook cannot read forbidden secret env/file/registry; positive grant allows only intended credential |
| Limits and recovery | Session caps/output budget, Job basic lifetime | Per-task Job memory/CPU/process caps plus authenticated checkpoint and lease | Physical exhaustion, child tree/escape, crash, revoke, stale owner epoch and lost ACK => bounded stop or `UNKNOWN/RECONCILE_REQUIRED`, never replay or false drained |
| Privileged CORE | `CORE_EXECUTOR_DISPATCH_ENABLED=false` | Signed HIGH Broker remains separate from sandbox; owner-scoped grant only | Installed signed EXE + full transitive imports/updater/ancestor ACL + native FileID/PID/FILETIME and separate lower-user AccessCheck; independent epoch/CAS, no self-asserted HIGH |

**AppContainer is not a synonym for "network disabled":** capabilities,
loopback exceptions and brokered APIs must be explicitly configured and
tested. **Restricted token alone is not automatic root confinement.**
A Windows Job cannot be counted as an AppContainer, and neither a private
desktop nor command-line filters meet acceptance.

## 4. #03 integration handoff (source-only proposal, no new API)

1. **#05 / workspace owner:** fix #786 `workspace.snapshot` root recheck;
   issue taskId, protected root, handle-rooted file grants and reviewed
   base/worktree SHA; preserve the RED QA before merge.
2. **#03:** consume an independently signed, immutable
   `taskId + owner/device/epoch + OS identity + requested process policy`
   only after #04 grants. Future launcher must create every task child
   with restricted/AppContainer token and verified Job before first
   instruction; return explicit `OS_PROVIDER_UNAVAILABLE` if any
   requested process boundary is missing. Do not silently downgrade
   to normal `spawn`.
3. **#04/#13:** deliver owner epoch/revoke authority and actual task-bound
   network/IPC enforcement. #03 may record a verified provider receipt,
   but must not invent network rules or infer them from Job membership.
4. **#01/#08:** immutable requestId, checkpoint, start/stop/unknown
   reconciliation. A lost launch or stop ACK never permits blind
   re-launch with a new ID.
5. **#16/#26 QA, #00 integration:** keep original negative tests,
   separate source CI from installed physical restricted token and
   HIGH Broker evidence. No P1 feature acceptance until P0
   #271/#551/#576/#617 remain correctly blocked or have independently
   accepted real OS proof.

### Final disposition

- **Current ProcessManager:** Verified source/CI and synthetic native
  Windows Job for volatile roots only, NOT task-level OS isolation.
- **#786:** confirmed real `workspace.snapshot` scope leak on tested
  source; requires separate workspace/file owner fix.
- **Physical low-user/process handle:** #756 same-user
  `PROCESS_DUP_HANDLE=ALLOW` remains P0; no protected installed HIGH
  artifact or independent lower-user `AccessCheck`.
- **Production CORE/ROOT:** DISABLED. No live OS ACL, service, Broker, UAC,
  user process, network, cloud or VM mutation in this review.

**No product runtime implementation accompanies this document.**
