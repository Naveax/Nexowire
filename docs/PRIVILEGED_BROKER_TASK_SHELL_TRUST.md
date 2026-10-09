# Windows Highest Privileged Broker task shell trust

Tracking P0 #271 and Broker #260. This guide covers source-only hardening of the Interactive/Highest Broker Scheduled Task controller in src/agent/privileged-broker-lifecycle.ts, separate from both Hub task lifecycles.

## Previously exposed command boundary

The controller previously launched powershell.exe by relative name and inherited all caller environment variables. A substituted executable or module selected through caller PATH/PSModulePath could affect high-integrity task status and registration; future persisted tasks also named powershell.exe by relative path.

## Source changes

- All Broker controller calls now launch only C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, with shell:false, System32 working directory and bounded subprocess timeout.
- The controller resets PSModulePath to the Windows inbox module directory and imports the exact ScheduledTasks system manifest.
- Child process variables permit only fixed Windows OS paths plus non-secret task name and launcher path; caller PATH, PSModulePath, NODE_OPTIONS and unrelated environment hooks are not inherited.
- Future Scheduled Task registrations use the absolute Windows PowerShell executable; existing registered tasks remain unchanged until explicitly authorized installation.

## Verification

On Windows work-pc the real read-only Broker Scheduled Task status function succeeded after placing a fake powershell.exe first in the caller PATH and setting PSModulePath to the test directory. The fake file was not run. Regression tests cover launcher quoting and token non-persistence, null future run timestamps, exact interpreter/module environment, fake executable isolation, and invalid task fields. TypeScript typecheck and build pass.

## Limitations

This does not independently sign/attest the Nexowire JavaScript package or protect the legacy Highest Stack code tree. It does not deploy, install, remove, or modify any live privileged task or encrypted credential. P0 #271 remains open pending owner-approved protected full runtime, effective user write-denial and verified isolated administrator-controlled rollback. Broker #260 cutover remains blocked.
