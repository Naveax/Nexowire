# Read-only Windows runtime ACL audit

Tracking: Issue #271.

## Why it exists

Naveax's legacy Stack task currently runs at `Highest` while the installed
`C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js`
and `C:\ProgramData\NexowireStack` inherited an allow-`Modify` ACE for
`NT AUTHORITY\Authenticated Users`. Being owned by Administrators does **not**
make a file protected against modification when an untrusted principal has
`Modify` access.

A privileged task must never launch an executable, script or dependency tree
whose bytes or containing directory can be rewritten by a less-trusted Windows
identity.

## Operator diagnostic (no elevated changes)

```powershell
powershell.exe -NoProfile -File scripts/audit-windows-runtime-acl.ps1 `
  -RuntimeRoot 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire' `
  -Entrypoint 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js' `
  -FullTree -MaxObjects 10000 -MaxReportedFindings 80
```

By default the diagnostic walks only the entrypoint-to-package-root chain.
With **`-FullTree`**, it additionally inspects *every* file and directory
beneath that root without following junctions/reparse points, plus the runtime
root's parent directories up to the volume root. It reports unexpected owner
SIDs, untrusted allow-write ACEs (including ACL takeover, delete and data
modifications) and reparse points. An enumeration, ACL read or object-limit
failure terminates with an error; it never reports an incomplete inventory as
safe. Results are bounded using `-MaxObjects` (default 10,000, maximum
20,000) and `-MaxReportedFindings` (default 80, maximum 200); the report
includes `totalFindings` and `omittedFindings` so abbreviated evidence is
visible. Output shows relative component names and redacted outer-parent
indices, generic identity classes and reasons, never secret values or the full
absolute runtime path.

`packageTreeAudited:true` means the bounded tree scan completed, **not** that
imports outside the runtime root, external Node executable or task launcher
were checked. `dependenciesRecursivelyAudited:false` is unconditional.
The conservative check identifies allow-write grants and does not calculate a
full effective Windows access token or deny-ACE evaluation. Every elevated
entrypoint and updater path requires independent verification.

It never updates permissions, task registrations, files, accounts or process
state. `ownerApprovedElevatedExecution` is always **false**;
`dependenciesRecursivelyAudited` is always **false**. A clean report
does **not** certify the whole Node module graph, nor prove that the
launcher task, its parents or the updater cannot swap the runtime. The
report is intended to highlight failures, never grant privileged execution.

## Required repair before protected launch

The owner-authorized elevated repair must independently verify all imported
dependencies and parent replacement paths, install a verified code tree under
a protected administrator-owned path, deny untrusted write/rename/ACL
changes, preserve updater functionality without widening these grants,
retain trusted backups of the prior launch/task and prove rollback.
Re-read DACLs after updates. Do **not** use this script to elevate a
user-writable Node bundle, and do not alter live ACLs while services
are running without a tested recovery path.

This does not replace the Hub supervisor-handoff contract in Issue #265 or
the Broker credential/health repair in Issue #260.
