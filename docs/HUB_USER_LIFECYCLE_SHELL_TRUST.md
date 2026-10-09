# Windows user-scoped Hub Scheduled Task shell trust

P0 #271 and Hub handoff #265. The user-scoped Hub lifecycle in `src/hub/hub-lifecycle.ts` is separate from the higher-privilege Hub Boot lifecycle. Previously it resolved `powershell.exe` through the caller's PATH and copied `process.env` into the task registration/status and legacy supervisor preflight subprocess. A local user-controlled fake executable/module path could interfere with read-only cutover results or scheduled task registration.

The lifecycle now launches only the inbox `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, with `shell:false`, System32 working directory and a bounded process timeout. Before the task script it resets `PSModulePath` to the Windows module directory, and imports absolute manifests for `ScheduledTasks` and `NetTCPIP`. The process environment contains only pinned Windows system variables and four optional Hub task-specific values: `NEXOWIRE_HUB_TASK_NAME`, `NEXOWIRE_HUB_LAUNCHER`, `NEXOWIRE_HUB_PREFLIGHT_PORT`, `NEXOWIRE_HUB_RESTART_REQUIRED`. It does not inherit the caller's PATH, PowerShell modules, Node.js preload hooks, AppData or temporary paths.

The future user-scoped Hub Scheduled Task action also records the absolute inbox PowerShell path rather than a relative command name. These changes do not modify an existing task definition until separately authorized installation code is invoked. No production task or service was changed by these source-level changes.

## Regression evidence

On Windows work-pc, 18/18 targeted tests pass across user Hub lifecycle, protected Hub Boot task, and the legacy supervisor blockers. The read-only supervisor preflight succeeds even when a deliberately fake `powershell.exe` is placed first in caller PATH and an untrusted PowerShell module directory is supplied. Typecheck/build and git diff checks pass.

## Boundaries

The standalone user-scoped Hub lifecycle is not an administrator-protected SYSTEM replacement. The fixed PowerShell executable does **not** authenticate the entire Nexowire JS runtime, guarantee a trustworthy task owner's identity, or repair the old writable elevated Stack. The safe-to-cutover flag remains false. The owner must still approve a reversible protected cutover after P0 #271 integrity, updater, actual non-admin write denial, and protected rollback gates are satisfied.
