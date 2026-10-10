# Bridge Guardian task identity and protected launcher: read-only preflight

Related to #323 and P0 #271. This module is a **source-only inspection contract**, not a task installer or a running Guardian service.

The future Guardian must be a **different task** from the recoverable `Nexowire Privileged Broker` task. OFF disables/stops that Broker; Guardian needs an independent owner-authenticated connection, source, credentials and process lifetime so that future ON remains possible.

A trusted Windows Scheduled Task collector can pass its structured snapshot through `verifyBridgeGuardianTaskSnapshot(snapshot, expectedCurrentUserSid)`, which requires:
- Exact `Nexowire Bridge Guardian` task at root `\\`, Running, with **Interactive** logon, **Highest** run level, the correct per-user SID and an enabled logon trigger scoped to that SID.
- Exactly one action: pinned `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, precisely formed non-interactive `-File` invocation of `C:\ProgramData\Nexowire\bridge-guardian\launch.ps1`, and the expected working directory. Alternate script, injected arguments, second actions and user-controlled PowerShell paths are rejected.
- An identity-only output explicitly returns `sourceAclVerified:false` and `hubChannelVerified:false`, so passing task metadata does not accidentally authorize privileged operations.

The separate `verifyBridgeGuardianSourceAcl()` performs read-only source root, ancestor and launcher `lstat`/reparse checks, followed by the existing pinned Windows private ACL verifier for each. It must fail when no separately installed protected Guardian source exists, as expected today.

**Important limitations:** Task snapshot schema is the normalized output expected from a **future trusted local collector** and cannot authenticate untrusted JSON. The source-check is time-of-check/time-of-use sensitive; checking three paths cannot verify an entire Node dependency tree or publisher identity. No trusted Windows task snapshot collector, executable provenance/signature verification, authenticated Guardian Hub session, local user consent, protected installer, atomic replay ledger, actual scheduled-task control or rollback implementation is introduced here. A correct future implementation must also revalidate immediately before executing any action and independently verify machine postconditions. Do not deploy or auto-register a new privileged task on the existing live runtime while P0 #271 remains unresolved.

Unit tests are synthetic and do not create, start, stop, enable, disable or edit any Windows Scheduled Task or file ACL.
