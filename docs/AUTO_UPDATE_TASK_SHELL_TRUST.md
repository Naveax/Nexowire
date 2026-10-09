# Windows automatic updater task shell trust

The once-per-hour limited-user Nexowire automatic updater must not depend on a caller-controlled PowerShell executable search path. This task uses the privileged Broker only after its separate authority verification; spoofed task status or registration is therefore unsafe.

## Source changes

- All automatic updater status/install/enable/disable/uninstall shell operations use the exact Windows inbox PowerShell at C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, shell:false, System32 working directory and a bounded execution timeout.
- Each task operation resets PSModulePath to the inbox Windows module location and explicitly imports the ScheduledTasks manifest by its full system path.
- The PowerShell child environment includes only fixed Windows system variables. Caller PATH, PSModulePath, NODE_OPTIONS, user application hooks, other environment inputs and temporary executable directories cannot select the interpreter or ScheduledTasks implementation.
- Future user-limited scheduled task registrations use the full inbox PowerShell path instead of relative powershell.exe. Existing task registration is unchanged until separately authorized installation.
- The existing task-owner disabled state protection, hourly recurrence, Limited run level and Broker authority requirement remain unchanged.

## Verification

Windows work-pc ran the actual read-only auto-updater task status query while a bogus powershell.exe executable was placed first in PATH and PSModulePath was pointed at the untrusted test directory. The fake executable was ignored. 14/14 focused auto-update tests passed; TypeScript typecheck and build passed.

## Boundaries

This is source-only subprocess hardening, not an updater rollout, a privileged cutover, a signed JavaScript publisher proof or live ACL remediation. Old Highest legacy Stack P0 #271 remains writable to Authenticated Users until separately authorized, rollback-tested protected runtime deployment. No real scheduled task, protected secret, Hub/Broker or active session was modified.
