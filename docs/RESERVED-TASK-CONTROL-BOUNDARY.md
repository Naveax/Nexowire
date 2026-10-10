# Protected Nexowire Scheduled Task activation boundary

Generic `windows.task.control` can manage ordinary owner-controlled Scheduled Tasks but must not start elevated Nexowire runtime tasks without the protected code and owner-identity preflights.

`Nexowire Privileged Broker` and `Nexowire Stack` reject generic **START** and **ENABLE** actions, case-insensitively and regardless of task path. Checks occur in TypeScript **before spawning PowerShell** and again inside the PowerShell command **before any Scheduled Task lookup**. The dedicated Broker lifecycle requires its principal/executable/launcher checks plus protected ACL preflight; the Stack remains under #271 security-cutover restrictions.

**Emergency STOP and DISABLE remain available** through the existing authenticated, OS-authorized general task capability. Denying those would make a compromised running privileged task harder to stop. None of these gates bypass Windows permissions or authorize arbitrary callers. They also do not provide Admin Bridge web-to-device actuation (#323).

Focused tests never start/stop an actual protected task. Baseline `test/windows-control.test.ts` produces two unrelated ACCESS_DENIED failures under this non-elevated development account, reproduced on the unchanged source worktree. CI is authoritative for all cross-platform checks.
