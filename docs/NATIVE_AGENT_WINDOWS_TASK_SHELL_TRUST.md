# Windows Native Agent Scheduled Task interpreter trust

The Windows Native Agent lifecycle previously invoked `powershell.exe` by relative name using a child process that inherited all caller environment variables. Both task state inventory and install/start/stop/uninstall paths could therefore be redirected through user-controlled PATH/PSModulePath. A future registered task action also used a relative executable.

## Changes

- Windows Scheduled Task commands now use the fixed inbox executable `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` and explicitly import the absolute system `ScheduledTasks.psd1` manifest after resetting PSModulePath.
- A separate Windows-only environment passes only trusted system paths and the Native Agent task name/launcher; user PATH, PSModulePath, NODE_OPTIONS, arbitrary hooks and temporary directories are excluded. The subprocess runs with shell:false, fixed System32 cwd and bounded timeout.
- Future Native Agent user-limited scheduled task registrations use the absolute inbox PowerShell path. Existing task registrations are not rewritten unless explicitly installed.
- Linux systemd and macOS launchctl execution continue to use their existing lifecycle environment; this source change only isolates Windows PowerShell task calls.

## Verification

Windows work-pc ran real read-only Native Agent Scheduled Task inventory with a bogus `powershell.exe` placed first in caller PATH and an untrusted PSModulePath. The query completed and the fake executable was not used. 10/10 focused Windows/cross-platform Native Agent tests passed; TypeScript typecheck and build passed.

## Limits

This is source-only task subprocess hardening. It does not authorize live task reinstall, stop/start existing Agents, change credentials, independently sign the Nexowire JS code or remediate the writable elevated legacy Stack. P0 #271 remains open pending protected full imported runtime and an administrator-tested rollback.
