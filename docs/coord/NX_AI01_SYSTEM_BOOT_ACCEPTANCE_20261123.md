# NX AI-01 | SYSTEM Hub boot identity and protected state | 2026-11-23

## Scope / evidence
- Base: `Naveax/Nexowire` #1160, HEAD `83c8b651106ecd1244fb9d982cf94fd390c15b6b` (checked 2026-11-23).
- This AI-01 branch changes only Hub boot/lifecycle-owned source and Hub boot tests.
- Source acceptance does **not** constitute Windows physical acceptance. Only AI-09 may mutate production Work-PC.
- Existing 1.0.8 Work-PC state (`Nexowire Hub Boot` absent; CORE `REVOKED_LOCALLY`) is historical and must be rechecked, not inferred from an ONLINE agent or HTTP 200.
- `C:\ProgramData` and `C:\Windows` remain explicit current-build path invariants. A Windows deployment with relocated system directories must fail closed pending dedicated trusted-known-folder support, **not** guess from `%ProgramData%` inherited environment.

## Source invariant matrix
| Surface | Required property | Negative case | Expected |
|---|---|---|---|
| Task root/name | Single `\\Nexowire Hub Boot` | duplicate / another task path | DENY |
| Task principal | `S-1-5-18`, ServiceAccount, Highest | wrong SID / limited principal | DENY |
| Task action | one absolute trusted PowerShell executable + exact launcher args | wrong executable, args, or nonempty working directory | DENY |
| Task trigger | exactly one enabled `MSFT_TaskBootTrigger` | no trigger, AtLogOn, disabled, duplicate | DENY |
| Task visibility | COM differentiates true ABSENT, ACCESS_DENIED and unverified | hidden task | NOT verified absent, DENY mutation |
| State root | exact `C:\ProgramData\Nexowire\hub-state` | inherited user writable `NEXOWIRE_STATE_DIR` | DENY |
| Machine secret | exact `C:\ProgramData\Nexowire\hub-boot\control-plane-service-token.machine.dpapi.json` | user DPAPI/legacy plaintext reference | DENY |
| PID path | exact `C:\ProgramData\Nexowire\hub-boot\hub.pid` | user profile path | DENY |
| Parent trust | canonical path, private parent and target ACL, safe shared ancestors | junction/reparse, writable parent, delete/replace | DENY |
| Runtime | trusted Node/CLI and no Node preload flags | replaced/unsigned/untrusted executable | DENY before DPAPI or task mutation |

## Read-only commands for AI-09 (Windows PowerShell 5.1, owner-authorized VM)

Do not paste sensitive contents into issue/PR. Execute in a local disposable VM, not on production for this AI-01 role.

```powershell
$task = Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\' -ErrorAction SilentlyContinue
if ($null -eq $task) {
  'NOT_VISIBLE: cannot equate this with verified absence; use the COM visibility probe'
} else {
  $task | Select-Object TaskName,TaskPath,State
  $task.Principal | Select-Object UserId,LogonType,RunLevel
  $task.Actions | Select-Object Execute,Arguments,WorkingDirectory
  $task.Triggers | ForEach-Object {
    [pscustomobject]@{
      Type = $_.CimClass.CimClassName
      Enabled = $_.Enabled
    }
  }
}
Get-Acl -LiteralPath 'C:\ProgramData\Nexowire' |
  Select-Object Path,Owner,AreAccessRulesProtected,AccessToString
Get-Acl -LiteralPath 'C:\ProgramData\Nexowire\hub-state' |
  Select-Object Path,Owner,AreAccessRulesProtected,AccessToString
Get-CimInstance Win32_OperatingSystem |
  Select-Object Caption,Version,OSArchitecture,LastBootUpTime
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -eq 43110 |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

No `Get-Content` on DPAPI blobs, bearer tokens, raw SQLite, task credential dumps or secrets. If task is hidden, the source's COM visibility probe must be used; generic `Get-ScheduledTask` absence is insufficient.

## Disposable Windows VM acceptance, AI-09 execution only

1. Capture VM identity, Windows 10 19045 / supported Windows 11 build, Node22/24, owner SID, installer SHA, source commit, exact task XML backup hash, state/WAL/SHM counts/hashes and rollback snapshot.
2. On a disposable cloned state, validate ProgramData ancestor ACL, root and SQLite ACL, no reparse components, trusted executable digest/publisher, existing user Hub task/principal and lease of TCP port 43110. Never treat C: free space alone as proof of integrity.
3. Run source-only fixture tests and PowerShell identity probe with valid AtStartup task. Inject wrong SID, disabled trigger, logon-only trigger, multiple triggers, wrong action/working directory, inaccessible hidden task and path-swap/writable ancestor. Verify no creation, overwrite or secret unseal on denial.
4. In VM only, with explicit elevated owner approval, rehearse the AI-02 protected-state cutover; install one SYSTEM task; reboot with **no interactive sign-in**. Confirm task principal `S-1-5-18`, exact launch path and startup trigger; perform authenticated Hub WSS nonce/issuer exchange and attribute listener to the SYSTEM Hub PID. HTTP 200 alone is insufficient.
5. Reboot twice. Verify user Hub does not respawn/compete, agent and Broker identity are unchanged, state/WAL record counts and hashes are preserved or explained by authorized writes. Prove restart after interrupted install or absent task is fail-closed, never a synthetic PASS.
6. Simulate task start failure and rollback on disposable snapshot. Verify original user Hub task state restored only when allowed, no newer SYSTEM writes discarded and rollback secrets available. On UNKNOWN writer state, stop and preserve both state trees.
7. Record a separate evidence row for source tests, Windows PowerShell simulation, VM before-login WSS, real Work-PC acceptance and rollback. Missing VM/physical result is `NOT_RUN`.

## Failure stop conditions
- Incorrect/multiple/hidden Scheduled Task, no verified AtStartup, foreign action or principal.
- Wrong or writable ProgramData parent, reparse chain, unexpected file entries, untrusted executable or executable digest drift.
- No consistent cutover receipt, DPAPI scope mismatch, missing backup/integrity proof, active legacy Hub listener, unknown WAL writer/rollback state.
- No elevated local owner approval, task operation on production outside AI-09 or conflicting executor.

**Rollout boundary:** No direct changes to `main`, #1160, Windows production tasks, SQLite/DPAPI, or releases from this AI-01 branch.

## CI coverage gap and targeted operator test command (2026-11-23)

- For source SHA `95a268549196474464b19abd79e640eed6769115`, Portable Root run `45181707698` recorded **655 tracked test files, 35 executed, 620 NOT_RUN**. It did **not** execute the new AI-01 startup-trigger test. This is evidence only for that older SHA; later PR commits require new exact-SHA receipts.
- Generic CI `45181707815` passed on that older SHA but cannot be used as Windows PowerShell behavioral acceptance for the omitted tests.
- #1205 / AI-08 owns the reviewed Windows-hosted shard and execution receipts. Do not edit shared CI or rerun already-active identical workflows from AI-01.
- The SYSTEM install transaction now verifies the **actual registered task** (principal, action, AtStartup trigger, marker) **before stopping the legacy user Hub**, not only the preliminary candidate or registration arguments.

On an authorized disposable Windows runner, after clean checkout of **exact PR HEAD** and `npm ci`, run:

```powershell
npm run typecheck
$tests = @(
  'test/hub-boot-startup-trigger-integrity.test.ts',
  'test/hub-boot-handoff-transaction.test.ts',
  'test/hub-boot-root-boundary.test.ts',
  'test/hub-boot-status-legacy-user.test.ts',
  'test/hub-boot-task-shell-trust.test.ts',
  'test/hub-boot-hidden-task-visibility.test.ts',
  'test/hub-boot-protected-state-gate.test.ts',
  'test/hub-boot-shared-ancestor-trust.test.ts',
  'test/hub-lifecycle.test.ts'
)
node --test --import tsx @tests
```

These are source/PowerShell identity tests; they do **not** install or mutate a SYSTEM Scheduled Task. Verify runner SHA in the receipt. If the physical shared ancestor ACL check is unsupported in CI, record its specific SKIP/FAIL rather than quietly turning it green.
