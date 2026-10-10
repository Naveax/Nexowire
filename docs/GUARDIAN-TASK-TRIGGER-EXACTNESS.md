# Bridge Guardian task trigger exactness

The read-only Guardian Scheduled Task snapshot verifier previously trusted any task with **at least one** enabled logon trigger matching the current owner SID. A task could therefore also include a second enabled Time/Other trigger, duplicate logon trigger or a disabled unreviewed trigger and still pass task-identity verification.

The verifier now requires **exactly one** trigger, of kind `Logon`, `enabled:true`, bound to the exact currently verified interactive user SID. Extra, duplicated, disabled, unexpected-SID or unfamiliar triggers all fail closed with `BRIDGE_GUARDIAN_TASK_LOGON_TRIGGER_UNVERIFIED`. The inspector script remains read-only and continues to report bounded/sanitized snapshot data. Any future separate restart/recovery trigger requires an independently designed/approved policy and explicit regression updates; it cannot be slipped into a task as an incidental extra trigger.

A valid trigger snapshot is still NOT proof that the protected launcher source is safe, that the running process is actually the privileged Guardian, that an authenticated Hub session is in place, that replay storage survives abrupt power loss, or that owner-approved commands have been executed. The verification result still reports `sourceAclVerified:false` and `hubChannelVerified:false`.

No Windows Scheduled Task or source ACL was changed. Source-only; production P0 #271 remains OPEN.
