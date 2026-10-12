# Windows Highest Privileged Broker task shell trust

Tracking P0 #271 and Broker #260. This guide covers source-only hardening of the Interactive/Highest Broker Scheduled Task controller in src/agent/privileged-broker-lifecycle.ts, separate from both Hub task lifecycles.

## Previously exposed command boundary

The controller previously launched powershell.exe by relative name and inherited all caller environment variables. A substituted executable or module selected through caller PATH/PSModulePath could affect high-integrity task status and registration; future persisted tasks also named powershell.exe by relative path.

## Source changes

- All Broker controller calls now launch only C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, with shell:false, System32 working directory and bounded subprocess timeout.
- The controller resets PSModulePath to the Windows inbox module directory and imports the exact ScheduledTasks system manifest.
- Child process variables permit only fixed Windows OS paths plus non-secret task name and launcher path; caller PATH, PSModulePath, NODE_OPTIONS and unrelated environment hooks are not inherited.
- Future Scheduled Task registrations use the absolute Windows PowerShell executable; existing registered tasks remain unchanged until explicitly authorized installation.
- Before the installer reads/creates its DPAPI Broker token or writes a launcher or Highest task, it now runs the same **read-only full runtime source ACL and OpenJS-signer gate** used by privileged Hub Boot. User-writable AppData/staging Node binaries, CLI imports and mutable packages are rejected. It also rejects Node `execArgv` preload/import flags.
- The generated persistent Broker `launch.ps1` explicitly clears `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_ICU_DATA` and `NODE_EXTRA_CA_CERTS` before invoking Node. The Scheduled Task inherits the interactive account environment, which is **not** the sanitized task-registration subprocess environment.
- Elevated **install** and **uninstall** now reject arbitrary caller-supplied task names. Only `Nexowire Privileged Broker` under Task Scheduler root `\\` is accepted; foreign task folders are not searched or mutated. If a same-name root task already exists, the installer verifies its exact expected launcher/action, interactive Highest runlevel and current Windows owner **before** touching any DPAPI token or launcher, and again directly before task registration. Uninstall verifies the existing task identity before stopping or unregistering it. A mismatched task fails closed instead of being overwritten or removed.

## Verification

On Windows work-pc the real read-only Broker Scheduled Task status function succeeded after placing a fake powershell.exe first in the caller PATH and setting PSModulePath to the test directory. The fake file was not run. Regression tests cover launcher quoting and token non-persistence, null future run timestamps, exact interpreter/module environment, fake executable isolation, invalid task fields, Node injection-variable clearing before invocation, runtime/source verification, canonical root-task identity and install/uninstall identity-guard ordering before any mutation. TypeScript typecheck and build pass.

## Limitations

Runtime ACL/signer preflight is a snapshot, not runtime file-handle attestation or an independently signed Nexowire JavaScript release. The CLI tree may change after inspection and the old legacy Highest Stack remains unprotected. It does not deploy, install, remove, or modify any live privileged task or encrypted credential. P0 #271 remains open pending owner-approved protected full runtime, effective user write-denial and verified isolated administrator-controlled rollback. Broker #260 cutover remains blocked.
