# Nexowire protected Scheduled Task boundary

Generic `windows.task.control` is appropriate for ordinary owner-managed Windows Scheduled Tasks. It must **not** be an alternate route to mutate the privileged runtime tasks used by Nexowire itself.

The reserved names `Nexowire Privileged Broker` and `Nexowire Stack` now reject all generic `start`, `stop`, `enable` and `disable` actions regardless of supplied TaskPath. Guards run in TypeScript **before spawning PowerShell** and inside the Windows PowerShell script **before any Scheduled Task lookup**. This blocks unintended bypass of the dedicated Broker task-action/owner-SID and protected-launcher ACL checks. The separate Stack cutover is still blocked by P0 #271.

This does **not** remove general Windows task management for other task names and does **not** authorize the new Admin Bridge web UI to mutate protected tasks. Actual Admin Bridge remote actuation still needs an owner-verified command, device binding, replay guard, correct elevated user context and a verified receipt (#323).

Local Windows guard tests pass without touching any Scheduled Task. The existing `test/windows-control.test.ts` includes two machine-dependent ACCESS_DENIED failures under the current non-elevated development session. Both were independently reproduced on the unchanged baseline worktree, so they are not regressions introduced by this guard. CI must provide the authoritative cross-platform acceptance.
