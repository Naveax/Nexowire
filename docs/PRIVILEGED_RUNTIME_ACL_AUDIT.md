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
  -Entrypoint 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js'
```

The diagnostic validates absolute scope and walks the entrypoint, its parents,
and the specified root. It reports unsafe owner SIDs, untrusted allow-write
ACEs (including ACL takeover, delete, and data modifications) and reparse
points. Output shows only relative component names, generic identity classes
and reasons, not secret values or the full absolute runtime path.

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
