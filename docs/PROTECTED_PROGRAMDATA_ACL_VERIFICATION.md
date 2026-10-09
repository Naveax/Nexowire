# Protected ProgramData ACL verification

Related: P0 Issue #271 and elevated Hub boot setup Issue #265.

The flat `ProgramData\Nexowire\hub-boot` directory contains the
machine-scoped DPAPI envelope and the Windows Highest/SYSTEM task launcher.
Hardening this directory must not depend only on the exit code of
`icacls.exe`.

When the authorized elevated `hub boot-install` workflow invokes
`hardenWindowsProgramDataAcl`, the routine:

- removes inheritance without using unsafe recursive `/T` operations;
- grants SYSTEM and the Administrators group Full Control to the directory
  and each direct file;
- removes explicit allow grants to Users, Authenticated Users, Everyone
  and Interactive using stable Windows SIDs;
- **checks each directory/file DACL after modification**, before proceeding
  with future task-registration steps;
- rejects unexpected owner SIDs, reparse points, or any remaining untrusted
  allow-write ACE, including unrecognized local group/user principals.

Both `icacls.exe` and the read-only verifier are invoked via fixed Windows
System32 executable paths. They do not inherit caller-supplied `PATH`,
`PSModulePath`, user profile locations, or Node preload settings. The
PowerShell verifier imports the Windows inbox Security module using its
absolute manifest path and accepts only the exact expected success marker.
Unknown or unsupported Windows layouts fail closed. These checks prevent
untrusted executable/module lookup during an authorized elevated ACL
operation; they do not themselves authorize elevation.

A failed verification throws `PROTECTED_ACL_INTEGRITY_FAILURE`.
It is intentionally not treated as a successful protected install. The
verification is read-only; only the existing authorized installation
routine modifies ACLs.

This routine applies to a dedicated **flat** protected lifecycle directory.
It does **not** silently change the ACLs of Naveax's live v1.0.0
`C:\ProgramData\NexowireStack` tree or repair the confirmed
writable runtime in Issue #271.

Important: this is a conservative owner/allow-ACE check, not a complete
Windows effective-token policy verifier. As with the source-path gate, only
`C:\Windows` is currently accepted as a trusted PowerShell interpreter
location. Unsupported OS layouts fail closed.

Before converting any live task, the owner must separately validate
executable/import tree provenance, updater permissions, protected
task identity, DPAPI access, and a rollback procedure. Do not start an
elevated task from a user-owned staging checkout.
