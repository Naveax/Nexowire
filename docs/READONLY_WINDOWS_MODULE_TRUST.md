# Windows P0 read-only PowerShell module isolation

Related: P0 #271; Hub #265; Broker #260.

The legacy Stack diagnostics and encrypted scheduled-task backup helper are **not** authorization to elevate, install or migrate the runtime. They run with caller permissions and must not acquire executable PowerShell modules from user-controlled module search paths.

## Read-only helper entrypoints

- `scripts/audit-windows-runtime-acl.ps1`: absolute Windows inbox `Microsoft.PowerShell.Security` and `Microsoft.PowerShell.Management`.
- `scripts/inspect-legacy-cutover-readiness.ps1`: absolute Windows inbox `Microsoft.PowerShell.Security`, `ScheduledTasks`, and `NetTCPIP`.
- `scripts/backup-legacy-scheduled-task.ps1`: absolute Windows inbox `Microsoft.PowerShell.Security` and `ScheduledTasks`.

Every helper resets `PSModulePath` to the fixed Windows system module directory before invoking commands. Windows PowerShell 5.1 imports the inbox Security manifest under C:\Windows\System32\WindowsPowerShell\v1.0\Modules. PowerShell 7 instead imports its own built-in Security manifest from its engine-controlled `$PSHOME` directory; importing the 5.1 manifest in PowerShell 7 can fail because implicit-remoting proxy commands clash with local cmdlets. ScheduledTasks/NetTCPIP/Management remain pinned to fixed Windows inbox module paths. Both security-module paths are absolute; a missing module fails closed. A Windows layout without these trusted manifests **fails closed**. The protected Hub boot source gate independently isolates the child process environment and working directory; see `docs/PRIVILEGED_BOOT_RUNTIME_SOURCE_GATE.md`.

This prevents caller-provided `PSModulePath` from selecting a same-named module from a normal user-controlled directory. The change does not make a caller-writable script trusted: verify the exact script source and operate from an approved working tree. It does not attest task XML authority, archive signing, external imports, Windows effective access rights or secure elevated rollback.

## Validation

Windows CI runs the existing read-only tests plus `test/p0-readonly-powershell-modules.test.ts`, which checks all pinned module paths and performs a fixture ACL scan with a caller-supplied untrusted module search path. No test creates or modifies production Scheduled Tasks, DACLs or service credentials.

**P0 #271 remains open** until administrator-protected code installation, proven ACL repair, independent release authorization and successfully rehearsed protected task/secret rollback. This change is not a production cutover.
