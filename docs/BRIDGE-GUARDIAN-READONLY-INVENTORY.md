# Read-only Bridge Guardian task inventory

This script is **not** a Guardian installer. It does not grant privileges or control the Broker.

On Windows, from a trusted repository checkout:

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -File .\scripts\inspect-bridge-guardian-readonly.ps1
```

The inspector pins the inbox ScheduledTasks module under `C:\Windows\System32` and queries **only** the exact `Nexowire Bridge Guardian` root Scheduled Task. It emits one bounded JSON object with `auditOnly:true` and `privilegedOperationPerformed:false`.

- `SNAPSHOT_ONLY`: exactly one candidate task was readable. Task identity, principal SID, action and trigger metadata are present **but are not trusted merely because they are returned**.
- `UNVERIFIED`: the Windows query failed, including any access denial. This is **not evidence the task is absent**.
- `ABSENT`: query succeeded and found no candidate.
- `AMBIGUOUS`: query returned an unexpected number of tasks; reject.

Unexpected or tampered action executable, arguments, and working directory are each represented only as `NONCANONICAL`; their original command strings are **never** printed. Non-matching SIDs are represented as `OTHER`, not dumped to logs. The expected canonical command is printed only if it matches the exact pin.

The separate `verifyBridgeGuardianTaskSnapshot` function (PR #335) will validate a normalized snapshot against the expected current interactive user. The read-only collector does not attest Windows file permissions, all source dependencies, publisher signature, authentic Hub session, owner approval, replay claims or process health. Its report must never automatically set `GuardianReady:true` without these independent checks.

No task is registered/started/stopped/enabled/disabled. No secret file is accessed and no DACL is modified. An owner-approved protected service installer, live Guardian channel, and production cutover are still blocked by [#271](https://github.com/Naveax/Nexowire/issues/271) and tracked in [#323](https://github.com/Naveax/Nexowire/issues/323).
