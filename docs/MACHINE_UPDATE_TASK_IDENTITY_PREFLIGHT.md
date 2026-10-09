# Machine update cutover: validate Scheduled Task identity before patching

The elevated machine update cutover previously required that tasks named `Nexowire Hub Boot` or `Nexowire Privileged Broker` exist and that their launcher files be present. A task's name alone does not establish the principal, run level or executable/action arguments that will actually run during cutover.

## Read-only task preflight

- Only query the expected Task Scheduler root path (`\`) with exact task names. Validate each task before touching launchers or stopping any service.
- Hub Boot must run `SYSTEM` (or equivalent SYSTEM SID/name) with `ServiceAccount` logon and `Highest` run level.
- Privileged Broker must have a non-SYSTEM interactive user principal with `Interactive` logon and `Highest` run level.
- Each must have exactly one Scheduled Task action: fixed `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` and an exact first-party `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<protected launch.ps1>"` argument string pointing to the expected `hub-boot` or `privileged-broker` launcher.
- Missing tasks, changed principal, non-elevated launch, unexpected action count, PATH-selected executable, or arbitrary launch script fail closed before changing the versioned launcher, task state or rollback backup.

## Work-pc test evidence

23/23 first targeted Windows tests PASS including 11 real isolated Windows PowerShell mocks for correct Hub/Broker action and negative principal, logon type, run level, executable, arguments, multiple actions and disappeared task. Existing single/both/missing-task plan fixtures and machine target provenance tests PASS. Typecheck PASS. Additional integrated security regressions run before publishing.

## Limits

The Broker account is validated as elevated-interactive and non-SYSTEM, not bound to a separately authenticated specific administrator identity. This check is a task identity gate at one point in time, not a replacement for privilege-safe Task Scheduler ACLs, signed complete installed code, direct low-privilege denial of edit/rename/delete, or a tested administrator-authorized Highest task / OAuth / DPAPI restore. Live P0 #271 remains open. No live scheduled task or launch path is changed by these tests.