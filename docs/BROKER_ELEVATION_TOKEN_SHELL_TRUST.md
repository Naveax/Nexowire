# Windows Privileged Broker elevation token inspection shell trust

The Broker's `isWindowsProcessElevated()` check previously selected powershell.exe from inherited caller PATH. A user-controlled executable could output `True` and cause the Broker's safety gate or health state to report elevation incorrectly even though it cannot actually grant Windows privileges.

## Changes

- Inspect the real current Windows process token only by launching the fixed inbox C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe with shell:false and System32 working directory.
- Pass an explicit minimal OS-only process environment: SystemRoot/windir/ComSpec/PATH/PSModulePath. Never inherit caller PATH, PSModulePath, Node preload hooks, AppData or temporary executables.
- Bound the synchronous subprocess to a 15-second timeout and 64 KiB stdout, continuing to return false on any timeout, launch failure, nonzero exit or anything other than exact `true` output.

## Verification

Windows work-pc ran real `WindowsPrincipal` token checks under normal PATH and poisoned caller PATH (with a fake powershell.exe and untrusted PSModulePath). Results matched, with no runtime token alteration. 8/8 scoped tests passed, including authenticated Broker health and privilege classifier, and typecheck/build passed.

## Boundaries

Elevation is a property of the Windows access token, not a switch an application can enable via PowerShell. The fixed binary does not provide privileged access, nor make a non-admin process elevated. This change is not a live Stack deployment, a protected signed full JS runtime, or an ACL/DPAPI/task rollback; P0 #271 remains open and current live services are untouched.
