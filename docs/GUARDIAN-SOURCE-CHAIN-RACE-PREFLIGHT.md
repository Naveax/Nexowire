# Guardian protected source chain: read-only stability preflight

The future protected Guardian launcher is not installed or production-attested. The `verifyBridgeGuardianSourceAcl` function remains a read-only, **source-only** preflight and is **not** permission to run a Windows Scheduled Task.

The pinned wrapper checks exactly these three source components:

- `C:\ProgramData\Nexowire`
- `C:\ProgramData\Nexowire\bridge-guardian`
- `C:\ProgramData\Nexowire\bridge-guardian\launch.ps1`

Each path must have the expected directory/file type, no symlink or launcher hardlink, and a trusted private ACL. During the inspection, the source chain is revalidated against the same file identity and modification metadata immediately after each ACL check and again across all paths at the end. Directory-child inventories are compared because Windows directory timestamps do not always detect child creation or deletion.

`inspectGuardianSourceChainSnapshotOnly` is the injectable mechanism for isolated regression tests. It accepts caller-supplied paths and ACL checks solely for testing and **cannot attest** production identity or grant privileged command authority. The production wrapper retains hard-pinned paths and `verifyWindowsPrivateAcl`.

This detects some source/ACL time-of-check versus time-of-use races, but it is **not** atomic filesystem attestation; it cannot prevent a swap after the last observation. Protected installation, Task DACL/identity verification, authentication, key enrollment, owner approval and P0 [#271](https://github.com/Naveax/Nexowire/issues/271) remediation remain mandatory. No production service, task, ACL, Worker, D1, or Guardian operation occurs here.
