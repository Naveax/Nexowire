# Machine update protected tree and native runtime preflight

P0 #271: a string-canonical machine update root and checksum-verified ZIP are insufficient protection against replacing Highest/SYSTEM launcher code when C:\ProgramData\Nexowire is writable to ordinary authenticated users. Machine update must fail closed before staging changes or detached cutover.

## Source-only barriers

- A read-only fixed inbox Windows PowerShell + full-path Microsoft.PowerShell.Security module audit checks the pre-existing C:\ProgramData\Nexowire tree, including existing descendants and ancestors for directory reparse points. It rejects any item that is a symlink/junction, an untrusted owner, or an allow ACE granting untrusted write/delete/permission-changing rights. Only SYSTEM, Administrators and TrustedInstaller are accepted as trusted owner/writer SIDs. The scan is bounded to 25,000 objects and 120 seconds; a missing root, inaccessible file, unexpected output or error is refusal, not approval.
- The child audit environment cannot inherit caller PATH, PSModulePath, NODE_OPTIONS, user profile temp or process hooks. One exact success marker is accepted. No ACL is changed by the auditor.
- The machine updater invokes this audit BEFORE downloads/staging/ACL changes, AFTER the newly staged runtime, and IMMEDIATELY BEFORE detached cutover.
- After staging and ACL tightening, the existing independent protected runtime validator also checks the staged node.exe signer (valid OpenJS Foundation), the CLI import code subtree and ancestor DACL/reparse protection. No cutover helper is written unless both root and runtime gates pass.

## Verification on Windows work-pc

26/26 focused machine update and privileged runtime tests PASS, npm typecheck/build PASS. The real read-only auditor accepted the OS-protected inbox Microsoft.PowerShell.Security module tree and rejected a user-owned/writable temporary test directory with a poisoned caller PATH/module search. No update was scheduled or live ACL changed.

## Current live blocker

A read-only Naveax inspection on 2026-10-09 found both C:\ProgramData\Nexowire and C:\ProgramData\NexowireStack owned by Administrators but each granting Authenticated Users: Modify. Therefore the new preflight is expected to REFUSE a real machine update on the current live configuration. This is correct fail-closed behavior, not a successful security remediation.

## Remaining verification

This audit is a point-in-time scan, not a replacement for administrator-owned root installation and actual low-privilege effective Windows access denial after every update. It does not independently authorize/sign the JavaScript package publisher, prove DPAPI/OAuth or Highest Task Scheduler restore, or eliminate all TOCTOU/path races. The complete runtime must be installed under an admin-protected parent with a verified updater and reversible authorized cutover. P0 #271 remains OPEN; live Stack and durable sessions are unchanged.