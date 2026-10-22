# #780 P1: Task Sandbox Windows Job / ProcessManager source-feasibility audit

**Owner:** #03 (Windows Job / process). **Snapshot:** PR #763 HEAD `e67f8f4ce14adb161a81f1f1ab45becbf5d7f40c` on 2026-10-22.
**Scope:** Source inventory + future acceptance conditions **only**. No code changes, installed agent, UAC, elevated Broker, ACL, user-process, or VM actions.
**Production decision:** NO-GO for a task-specific OS sandbox and for signed HIGH CORE/ROOT Broker.

## 1. Separate these security boundaries

A task-specific filesystem root is not an OS process sandbox. A Windows Job primarily
groups/limits processes and supports bounded lifetime management; it does not
by itself remove filesystem permissions, create a restricted user token, isolate
secrets, or deny TCP/UDP/DNS. A Windows private desktop is a GUI-routing boundary,
not a network compartment or a low-privilege token. A signed HIGH Broker is
**outside** untrusted task execution and would require separate signed owner /
device / epoch / intent, independent installed-image proof and physical acceptance.

Threats: untrusted task code, shell commands, descendant processes, Git hooks,
alternate filesystem paths (reparse/junction, ADS, hardlink), same-user handle
duplication, inherited environment secrets, sockets and lost mutation ACK.
Never mark any task "sandboxed" based on `cwd` or a successful source test.

## 2. Proven inventory at the exact source SHA

| Capability | Source evidence | Present today | Sandbox/security status |
| --- | --- | --- | --- |
| Volatile Windows process launch | `src/agent/process-manager.ts:1022-1124`; `src/agent/windows-job-owner.ts:92-185` | `process.start` launches a suspended root, verifies Job assignment and PID creation identity before resume; buffers output | Actual Job membership of root; **not** a restricted task token, file-root or network sandbox |
| Native Windows Job Object | `native/windows-job-owner.c:74-105,139-190` | Unnamed Job, `KILL_ON_JOB_CLOSE`, `CREATE_SUSPENDED`, `AssignProcessToJobObject`, parent monitoring, fail-closed verification gate | No proven protected Job/process handle DACL denying same-user `PROCESS_DUP_HANDLE` |
| Kernel Job attestation | `src/agent/windows-job-kernel-attestation.ts:13-54` | Independently queries kernel Job membership, creation FILETIME and Job flags; ignores marker as authority | Synthetic root identity, **not** signed installed HIGH Broker or complete descendant inventory |
| Windows stop and recovery | `src/agent/process-manager.ts:1370-1450` | Job stop is `requested`/`unconfirmed`; lost guardian/recovered PID cannot silently become verified tree cleanup | No guaranteed global kill for out-of-Job children or when an attacker retains a Job handle |
| Same-user Job handle problem | `test/windows-job-duplicate-handle-risk.test.ts:29-80` | Physical adversarial fixture retains an unnamed Job via duplicated query handle after guardian kill; root remains alive, status `orphaned` | **PROVEN open P0**: denial of `PROCESS_DUP_HANDLE` against a protected installed guardian is missing |
| Breakaway and nested Job | `test/windows-job-breakaway.test.ts:8-31`; `test/windows-job-hostile-nested.test.ts:7-21` | Synthetic direct breakaway request denied; hostile nested job fails closed | Not proof that every COM, UAC, WMI, Git, or indirect task side effect is in the Job |
| 100-cycle output and PID | `test/qa-19-windows-job-hosted-fast-exit.test.ts:15-95` | 100 synthetic stdout/stderr-before-terminal cycles with correct verified root metadata | Output integrity and Job membership, not task sandbox |
| Session stream and quotas | `src/agent/process-manager.ts:16-75,1022-1113,1240-1280` | Session max count, buffered output caps, read/write cursor, persistent metadata | No demonstrated task-specific kernel CPU/RAM/PID budget, network or file quotas |
| Durable worker | `src/agent/process-manager.ts:805-1018` | Worker-root UUID storage, separate durable process monitor, control and restart logic | Detached worker uses `env: process.env`; no mandatory restricted-token launch |
| Headless `shell.exec` | `src/agent/executors.ts:342-375,436-463,2296-2300` | Direct `spawn` via `runProcess` with timeout/output cap and optional checked `cwd` | **Does not use the verified native Windows Job** in the inspected direct headless path; no OS sandbox |
| Workspace / Git checks | `src/agent/executors.ts:1041-1100,1360-1410,2068-2108` | Git root discovery, status/check runner for recognized workspaces | Git worktree and selected cwd do not confine Git hooks or subprocess filesystem/network access |
| File API path policy | `src/agent/path-policy.ts:12-25,27-118` | Realpath on existing paths; check existing ancestor on creates; allowed roots may be home or `*` | Agent-level pathname policy only, not per-task capability, no retained OS root handle |
| Private desktop and env | `src/agent/windows-private-shell.ts:106-127,146-189`; `src/agent/ai-workspace-default.ts` | Windows UI route, explicit environment allowlist for private shell, WSL GUI fail-closed | Private GUI ≠ process/secret/network sandbox; standard `runProcess` and volatile `process.start` inherit `process.env` |
| Privileged Broker | `src/agent/privileged-broker.ts:112-145,225-236`; `src/security/core-broker-executor-contract.ts:12,131-198` | Loopback/bearer capability flow and SOURCE-ONLY preapproval contract | Loopback is not per-task network isolation; `CORE_EXECUTOR_DISPATCH_ENABLED=false`; installed HIGH not attested |
| Native current-token / PID QA | `scripts/audit-core-broker-fixture-effective-access.ps1`, `scripts/audit-core-broker-fixture-pid-handle.ps1` | TEMP-only `CreateFileW` effective access, synthetic `GetProcessTimes`, same-user `PROCESS_DUP_HANDLE` ALLOW | **Not** separate low-user vs signed installed HIGH process AccessCheck or protected-Job handle DACL |
| Linux/macOS launch | `src/agent/process-manager.ts:400-449,1075-1086` | Detached POSIX child/process-group stop attempt with honest uncertain outcomes | No verified namespace/container/seccomp or macOS task sandbox on this path |

### Source reviewed but capabilities **not found/accepted**

On the inspected task/process launch path no source-backed evidence establishes:
AppContainer/restricted-token task launch, WFP or task-specific network filter,
mandatory network-denied egress (including DNS/loopback), task-mount boundary,
per-task trusted root-relative file handles, independent loaded DLL closure,
signer/rollback of installed native HIGH Broker, or a guarded process DACL
rejecting same-user duplicate-handle access. Report **MISSING/BLOCKED**,
never `AVAILABLE`.

## 3. Windows security gaps and proposed future direction (NOT IMPLEMENTED)

**Task root and filesystem.** `PathPolicy.resolveForCreate` resolves an ancestor
then yields a pathname; another actor may replace path components before a
later mutation. For #780 the filesystem owner (#05) should implement protected
task root + explicit external grants with real OS root-relative retained
no-follow handles, file identity, reparse/ADS/hardlink/rename/race negatives.
Neither `cwd` nor a Git worktree is an access-control boundary.

**Whole process tree and Job handles.** Reuse verified suspended-root Job launch
for appropriate volatile tasks but close paths that bypass it:
`shell.exec`, detached durable worker, Git check runner, private desktop
worker, indirect script/Git-hook descendants. Any future restricted task
identity needs physical process/Job handles denied to a separate low-user
adversary; `PROCESS_DUP_HANDLE` DENIED; no handle inheritance; exact
PID+creation FILETIME+signed installed image FileID / epoch; bounded process
drain with UNKNOWN if owner/guard dies. The current same-user fixture
that yields ALLOW is a **security finding**.

**Signed EXE/import/updater tree.** #551 signed installer/rollback, per-DLL
pinned Authenticode publisher and hash, independently enumerated full
transitive loader imports, protected EXE/updater/ancestor ACL, no-follow
handle/volume/file ID and genuine alternate low-token effective access
witness remain blocking. `GetAccessRules` text alone is not a kernel
access check; current TEMP native access test is not a Broker acceptance.
#271 live writable elevated ProgramData is a hard NO-GO.

**Network and secrets.** Native Job does not block direct TCP/UDP/DNS/loopback.
A Broker listening on localhost does not block other network connections.
Future sandbox requires verified restricted identity + dedicated WFP /
AppContainer or equivalent real OS egress policy, default-deny and signed
per-destination grants, plus separate namespace/secrets management. Standard
shell and durable worker use inherited `process.env`; environment regex or
proxy variables are not secret/network isolation.

**Durable authority and failure behavior.** TaskId, root, base Git SHA,
requestId, owner/device/epoch signed grant, process budget and immutable
checkpoint must bind all launch/stop/readback operations. On crash,
revocation, lost ACK, wrong epoch or disk-full, return
`MUTATION_STATE_UNKNOWN / RECONCILE_REQUIRED`: never blind replay.
No P1 workflow may widen CORE or imply HIGH granted.

## 4. Cross-platform feasibility, not availability

| OS | Candidate implementation, owned elsewhere | Current acceptance |
| --- | --- | --- |
| Windows | Restricted token/AppContainer where appropriate, verified Job launch, genuine process/Job DACL, handle-rooted files and WFP/network compartment | Job root-membership tests exist; task root/process/network/secret isolation unverified |
| Linux | User+mount+PID+network namespaces, cgroups and seccomp/rootless container with tested out-of-root and egress negatives | Process management exists; namespaces are not proven by this source |
| macOS | Separate OS identity plus supported native sandbox/VM with tested file/network isolation; no GUI-based trust assumption | No inspected enforced task-root OS isolation |

VM / cloud options are future #780 P2 work. No live VM or paid cloud service
is needed or authorized for this inventory.

## 5. Acceptance checklist and ownership

1. **#03 Process:** all task launch paths under same verified restricted token
   and task Job; no out-of-Job descendants, exact PID+FILETIME+file identity;
   low-priv `PROCESS_DUP_HANDLE` / Job handle access DENIED using the
   actual installed signed process; measurable kill/drain or UNKNOWN.
2. **#05 File sandbox:** pinned task root and grants, handle-relative
   write/rename/delete, independent file ID and complete imports,
   symlink/junction/hardlink/ADS/rename/disk-full tests.
3. **#04/#13 Network and authority:** real per-task OS egress denial
   for DNS/TCP/UDP/loopback, signed destination grants, revoke-start CAS,
   no secret/token leakage.
4. **#01/#08 Journal and checkpoint:** crash/reconnect/owner epoch and
   mutation-UNKNOWN reconciliation, immutable signed postconditions.
5. **#16+ independent QA / #00 merge:** exact-SHA source, hosted CI,
   physical signed installed artifact, separate low-user OS negative tests,
   and staging evidence. Never conflate source/CI PASS with production.

**Hard blocker**: #271 / #551 / #576 / #617. Elevated execution remains
source-only and DISABLED. Do not install Broker, touch UAC/ACL/Agent,
run ReVoltVPN, or terminate existing user processes.

## 6. Provenance at snapshot

Parent exact HEAD `e67f8f4ce14adb161a81f1f1ab45becbf5d7f40c`.
- GitHub full CI run `39803136306`: **7/7 SUCCESS**.
- Dedicated Windows JSON/native QA `39803137184`: **SUCCESS**.
- TEMP-only current-test-token Windows QA `39736305459`: **SUCCESS**
  on its own earlier source; no installed HIGH Broker proof.
- #753 independent unchanged wrong-type negative tests were previously
  verified PASS against the corrected owner source without weakening them.

**This is a docs-only feasibility review.** No process/sandbox API or
native implementation was changed; absence of required source is a
BLOCKER rather than an invented bug fix.
