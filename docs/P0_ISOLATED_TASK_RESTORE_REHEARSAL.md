# P0 isolated CurrentUser Scheduled Task restore rehearsal

Issue #271. This is a **real Task Scheduler API rehearsal** confined to a newly generated, disabled, triggerless, unprivileged fixture task. It is NOT a restore of the live Highest Nexowire Stack task or its OAuth/DPAPI service tokens.

## Command

Run from a verified checkout in an ordinary, non-elevated Windows user context:

    powershell.exe -NoProfile -NonInteractive -File .\scripts\rehearse-isolated-scheduled-task-restore.ps1

There are **no parameters**. Passing a production task name is explicitly rejected. The script refuses elevated Administrator and LocalSystem tokens.

## What is tested

1. Generate a cryptographically unpredictable fixture task name with a fixed Nexowire-P0-Restore-Fixture- prefix and a 32-digit GUID. Refuse an existing name.
2. Register exactly that fixture in the invoking user's root Scheduled Tasks namespace, with a benign C:\Windows\System32\cmd.exe action, **no triggers**, an interactive-user, least-privilege principal, and disabled settings. **Never start it.**
3. Export its task XML into process memory and validate the disabled state and benign action.
4. Encrypt/decrypt the XML in process memory using Windows DPAPI CurrentUser with a fixture-specific entropy purpose; compare SHA-256 digests before and after unsealing. Neither a plaintext XML backup nor a DPAPI blob is saved to a backup file.
5. Unregister just that unpredictable fixture task, then restore that same fixture from its unsealed XML and verify Task Scheduler's resulting principal, disabled setting, no triggers, and action.
6. Unregister the fixture even on failure, verify cleanup and clear byte buffers.

The script reports no task XML, token, user name or secret to stdout. A successful result unconditionally states restoredRealStack=false, protectedCredentialsRestored=false, productionTaskChanged=false, authorizedToElevate=false and safeToCutover=false.

A missing Task Scheduler service, a policy blocking task registration, failed DPAPI unseal, unexpected principal, unexpected action/trigger, or cleanup failure causes an error. There is no fallback that modifies another task.

## Live isolated test evidence, 2026-10-09

On work-pc as a non-elevated user, the fixture script returned:

- dpapiCurrentUserRoundtrip=true
- taskSchedulerXmlRestored=true
- fixtureDisabled=true
- fixtureHadNoTriggers=true
- fixtureRemovedAfterTest=true
- fixtureTaskExecuted=false
- restoredRealStack=false
- protectedCredentialsRestored=false
- safeToCutover=false

An independent Scheduled Task inventory before and after reported zero remaining fixture tasks. This only proves that the basic task XML + CurrentUser DPAPI roundtrip and registration mechanism works for the user's own inert task.

## Remaining production blockers

A SYSTEM/Highest supervisor has different ownership, logon and token requirements. This fixture deliberately does not read actual legacy task arguments or export a live task, grant SYSTEM access to CurrentUser DPAPI, preserve OAuth credentials, modify ProgramData ACL, or interrupt running Hub/Broker/Agent/durable sessions. Production rollback requires an administrator-controlled encrypted recovery artifact, verified real restore under a separately authorized isolation/maintenance procedure, and a comprehensive code/import/parent-path permission migration. Until then issue #271 remains OPEN.
