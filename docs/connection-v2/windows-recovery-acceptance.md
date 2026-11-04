# Connection v2 · V2-04 Windows recovery acceptance

**Scope:** child of #1003, exact original parent HEAD `30a905351c4bb91ad279e1f3532f8416c421ff67`.
**Owner:** Windows lifecycle/recovery only. No NAVEAX or Work-PC task, credential, Agent, Broker, CORE or DNS mutation.
**Status:** SOURCE CANDIDATE; physical disposable Windows VM reboot acceptance **NOT_RUN**. Production **NO-GO**.

## Evidence baseline (before this child)

- #1003 is OPEN/DRAFT. Its source HEAD `30a9053` diverges from main (62 commits behind as inspected 2026-11-04).
- Exact-head CI `41246756343` (Windows `browser-live` job `124671672695`) failed; assertion `task stop must stop the managed parent` was true when expected false. Other six CI jobs finished successfully; Release Readiness `41246756360` succeeded but does not override Windows failure.
- The prior launcher invoked Node using PowerShell's `&`; stopping the PowerShell scheduled action does not guarantee child/descendant termination. Its scheduler restart count was 999.
- Work-PC 2026-11-04 field notes: `Nexowire Hub Boot` SYSTEM task `HUB_BOOT_TASK_IDENTITY_MISMATCH`, last result 1, v1.0.4 protected launcher vs 1.0.8 Agent/Broker; separate user Hub task Disabled. Local Hub HTTP 200 after a controlled user Hub restart, but Native Agent initially disconnected; one controlled Agent restart restored both reported device sessions. **This is not a reboot or no-disconnect acceptance test.**

## Implemented source boundaries

- `Nexowire Cloudflare Connection` is a separate **Interactive/Limited** user-logon task, with exact owner SID, fixed System32 PowerShell action, exact launcher path, exactly one matching user AtLogOn trigger, `IgnoreNew`, and a bounded **3 restarts / 1-minute scheduler interval**. No automatic privileged task or CORE enrollment.
- Task identity mismatch fails closed. Reserved names `Nexowire Hub`, `Nexowire Hub Boot`, `Nexowire Stack` are rejected.
- The launcher builds a Windows **kill-on-job-close Job Object**, then creates the Node process **suspended**, assigns it to the job before resume and waits on the process handle. No PID-only kill, borrowed guardian, shell pipeline or unmanaged spawn window. If the launcher owner exits or Task Scheduler kills it, its job handle closes and all inherited descendants terminate. A failure to create/assign the job aborts before executing Node.
- Launcher SHA256 digest is written exclusively to a separate owner-protected file, verified along with launcher banner and reparse/ACL/owner checks on lifecycle control. This rejects accidental or cross-principal modifications. **This is not a publisher signature nor a defense against arbitrary code already running as the same owner.** V2-01 must independently prove first-party executable/publisher/credential custody.
- Environment injection: existing launcher strips `NODE_*`, `NEXOWIRE_*`, tunnel and proxy variables before reintroducing allowlisted protected Hub parameters. Startup does not adopt `Nexowire Hub Boot` or old protected launcher identities.
- Existing-task actions and principal are never forcibly replaced. No credential file is read, rotated or deleted during stop/uninstall; cleanup is limited to the verified disposable user connection launcher and its digest after owned task removal.

## Disposable Windows VM test procedure

Use a **disposable** isolated Windows 10/11 VM with a nonproduction user, snapshot, Node >=22, repository checkout at the exact child HEAD, and no configured production Cloudflare tunnel or real credentials. NEVER set the test gate on NAVEAX or Work-PC.

```powershell
npm ci
npm run typecheck
node --test --import tsx test/cloudflare-connection-lifecycle.test.ts
$env:NEXOWIRE_V2_04_DISPOSABLE_WINDOWS_VM = 'YES'
node --test --import tsx --test-concurrency=1 test/connection-v2-windows-recovery.test.ts
Remove-Item Env:NEXOWIRE_V2_04_DISPOSABLE_WINDOWS_VM
```

The hosted CI `browser-live` suite imports this test only on `RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=Windows`, `GITHUB_ACTIONS=true`. This provides 20 actual Task Scheduler cycles on a GitHub disposable Windows VM when CI reaches the test, **not reboot/logoff acceptance**; before exact SHA/job evidence the gate remains NOT_RUN. The lab operator can separately set the manual VM gate without touching live owner machines.

The gated VM test uses one random disposable task name, an isolated temporary directory, synthetic file-path credential placeholder, and no listening connector. It executes **20 real Scheduler starts/stops**, verifies a parent/child/grandchild process chain, compares native Windows executable path and creation time per PID, rejects survivors and PID reuse confusion, and cleans up only its own test task. Its environment gate also excludes GitHub Actions so a hosted runner cannot be mislabeled a disposable reboot lab.

**Additional required VM stress plan (not yet executed):**

1. Export a snapshot of the lab task definition; record action executable/arguments, principal SID/logon/run level, trigger, settings, task state, and launcher/digest hashes. Never export raw credential values.
2. Perform 20 normal task start/stop cycles, record command exit code, each PID + native creation timestamp, parent relationship, Job Object lifetime and stop-to-zero-descendant latency. Include cycles 1, 10, 19 and 20 in evidence.
3. Kill the launcher first and the Node parent first in separate cycles, observing that every job descendant dies. Kill a child first and verify the task remains owned and the launcher closes safely on parent exit.
4. Start under network unavailable, hub unavailable, missing protected credential source and malformed profile. Verify fail closed and no hot crash loop. Restore the network and check recovery under the bounded retry policy; **three attempts are not an unlimited outage recovery guarantee**.
5. Sign out / log in, reboot twice, and verify exactly one Interactive/Limited Cloudflare task, correct task SID and no SYSTEM hijack. Do NOT infer logoff/reboot reliability from 20 start/stop cycles.
6. Replace the lab launch file, digest, action, principal, AtLogOn trigger, restart policy and ACL in independent negative fixtures. Each negative must fail without altering a foreign task or killing unrelated PIDs.
7. Simulate hostile guardian, nested descendant, process identity switch and PID reuse. Never terminate by bare PID unless creation-time and executable handle identity are still verified.
8. Restore VM snapshot and verify **original task action, principal, LogonType, triggers and existing credential availability** are unchanged. Treat a missing password secret during XML task restore as a **rollback blocker**, not a successful rollback.
9. Repeat with a 15-minute network outage; capture recovery time/availability. Bounded scheduler restart alone may exhaust before reconnection. Full NO-DISCONNECT acceptance therefore requires an independently designed persistent health/retry policy.
10. Record Windows build, task XML hash, `npm run typecheck` exit code, every targeted test exit code, commit SHA, Actions run ID and job ID separately. VM evidence without these identifiers is INCOMPLETE.

## Read-only live-PC verification only

These commands **read** live task / process / network state; they do not register, start, stop, uninstall, unlock, change credential, repair ACL or activate CORE.

```powershell
$names = @('Nexowire Hub', 'Nexowire Hub Boot', 'Nexowire Cloudflare Connection')
foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskName $n -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $t) { [pscustomobject]@{Task=$n;Installed=$false}; continue }
  [pscustomobject]@{
    Task=$n; State=[string]$t.State; UserId=$t.Principal.UserId
    LogonType=[string]$t.Principal.LogonType; RunLevel=[string]$t.Principal.RunLevel
    Action=$t.Actions.Execute; Arguments=$t.Actions.Arguments
    Triggers=(@($t.Triggers) | ForEach-Object { $_.CimClass.CimClassName }) -join ','
    MultipleInstances=[string]$t.Settings.MultipleInstances
    LastResult=(Get-ScheduledTaskInfo -TaskName $n).LastTaskResult
  }
}
Get-NetTCPConnection -LocalPort 43110 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
try {
  (Invoke-WebRequest -Uri 'http://127.0.0.1:43110/health' -UseBasicParsing -TimeoutSec 4).StatusCode
} catch { 'HUB_HEALTH_UNAVAILABLE' }
```

Run separately on NAVEAX and Work-PC only with owner-directed read-only authorization. **None of these commands was run on the user's two PCs by this V2-04 child.** Avoid publishing full task arguments if they contain secrets.

## Hub Boot identity mismatch: safe repair / rollback decision

`Nexowire Hub Boot` runs under SYSTEM and uses protected launcher trust rules; **it must not be repaired by copying a user-task launch.ps1, rewriting a token, bypassing its identity checks or editing Agent/Broker versions in-place.** The separate `Nexowire Hub` user-logon task cannot impersonate pre-logon Hub Boot.

1. Read-only export the SYSTEM task XML and launcher path/image hashes, signer/publisher proof, file-ID, ACL/owner, running image creation identity and installed Agent/Broker version. Keep the original definition and protected credential escrow sealed. If these cannot be obtained, stop: `IDENTITY_UNKNOWN`.
2. Compare protected v1.0.4 launcher with the signed release manifest and compatible v1.0.8 protected binaries in **disposable VM**. A hash/version mismatch is a reason to block, not to disable a check.
3. Stage only an independently verified signed, compatible launcher and complete rollback bundle in the VM. Require old and new immutable identity, publisher signature, SID, DACL and import-closure validation. If unavailable, outcome **NO-GO**.
4. Under separately authorized maintenance, register/repair only the exact SYSTEM task and verify principal/action/creation-time via native readback. Never change or steal the Limited user task; do not use `-Force` against an unknown task.
5. On failure, restore the original signed bytes, task XML, exact principal/logon type/action/triggers and existing credential store using a witnessed offline backup; confirm with native readback. Task XML alone may not preserve password-backed credentials; without separately recoverable secrets, automated rollback is **blocked**.
6. Make no operational change on NAVEAX / Work-PC from this PR. Deployment/CORE activation requires separate owner approval and a reviewed migration.

## Acceptance matrix (as authored)

| Gate | Status | Evidence / blocker |
|---|---|---|
| Source fork from exact #1003 HEAD | PASS | isolated child branch; parent unchanged |
| Bounded task restart settings | SOURCE IMPLEMENTED | runtime Windows proof pending |
| Strict user-task action/SID/AtLogOn/IgnoreNew checks | SOURCE IMPLEMENTED | native negative fixtures pending |
| Stop kills parent and descendants | SOURCE IMPLEMENTED | exact child Windows CI pending |
| 20 native VM lifecycle cycles | **NOT_RUN** | gated test added, VM not accessed |
| Parent-first/child-first/reused PID/foreign guardian | **NOT_RUN** | VM stress plan required |
| Login/logoff/reboot/two-PC no-disconnect | **NOT_RUN** | not inferred from CI |
| Old protected launcher secure repair | **BLOCKED** | requires signed compatible artifact and complete backup |
| Rollback exact task principal and credentials | **NOT_RUN** | no authorized VM repair performed |
| Production Connection v2 / CORE | **NO-GO** | #1003 P1-A/B/C/D and physical acceptance still pending |

**Decision:** **WINDOWS RELIABILITY NO-GO** until real VM tests and independent review pass. A green Linux/unit suite or hosted Windows task test alone cannot certify 24/7 reboot reliability.
