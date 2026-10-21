# P0 #03: signed Broker full-tree and process identity source acceptance

**Scope:** Own isolated #03 child of #670. **Production: NO-GO**.
No real elevated Broker, VM, Windows service, Secure Desktop, or user process was modified.

## Source audit, not release trust
- `scripts/audit-core-broker-protected-tree.ps1` inspects the caller-declared
  launcher, imported files, updater file and **every ancestor directory up
  to the volume root** with Windows-native `FileSystemAclExtensions`,
  `GetAccessRules` including inherited and explicit ACEs. It checks
  low-trust write/create/delete/WRITE_DAC, missing files and reparse points.
- `src/security/core-broker-process-witness.ts` requires exact PID **and**
  Win32 creation FILETIME, volume serial, file ID, running image SHA-256,
  current owner/device/epoch and independently verified token/publisher,
  rollback, import-tree ACL and low-priv `PROCESS_DUP_HANDLE` boundary.
  A mismatched or recycled PID can never authorize PID-only `taskkill`.
- The existing token provider now obtains `GetProcessTimes` creation
  FILETIME for **only its own disposable PowerShell process**. This is NOT
  an identity attestation for any installed Nexowire Broker.
- Native ACL `GetAccessRules` is essential. In PowerShell 7 a raw .NET
  Security object may have no populated `.Access` convenience property.
  Absence of this property must never be confused with zero write ACEs.
- Replaced signed image and matching loose SHA-256 are rejected by
  #670's real Microsoft Authenticode test. The imported-module and updater
  trust test additionally rejects out-of-root files, tampered unapproved
  import source, dangerous temporary inherited Modify grants, missing
  module/ancestor ACL and unavailable evidence.
- A self-described list of loaded imports cannot prove it is COMPLETE.
  Signed release+rollback manifest, trustworthy runtime import
  enumeration, protected root owner permissions, running-file handle
  identity, and high-token process DACL enforcement are still missing.
  Therefore the tree report explicitly returns
  `importListIndependentlyEnumerated=false`,
  `signedImportManifestVerified=false`,
  `protectedCompleteImageTreeAttested=false`,
  `processDupHandleBoundaryVerified=false`, and
  `productionReady=false` regardless of favorable test inputs.

## Adversarial and truthful stop semantics
- Changed PID/creation ticks: rejected as PID reuse.
- Changed file ID, volume serial, runtime image hash: rejected.
- Wrong owner/device/epoch and untrusted stdout: rejected.
- Missing externally signed manifest, launcher, full imports/updater ACL,
  low-priv handle isolation or verified High-token: rejected.
- Lost ACK/external CAS outage: `UNKNOWN`, not retryable, no replay.
- Synthetic entirely green evidence: **still source-only denied**, no
  command execution or successful postcondition is invented.

## Independent blocker reconciliation
- #633 exact head `c429ed9c` CI and Release Readiness SUCCESS.
- #670 exact head `cc5f3db` hosted CI SUCCESS, but it inspects only
  a file+parent and its own disposable token, not the full import tree or
  an installed high-integrity Broker.
- #629 Windows hosted failure was physical Authenticode UNAVAILABLE and
  inherited ACL null; not fast-exit. The #19 100-cycle stdout result is
  separate Job output evidence, not signed process authority.
- #271 inherited writable ProgramData, #551 real pinned Nexowire-signed
  installer and rollback, #323 Admin Bridge effective state, #576
  reproducible low-priv Job handle retention, and #617 external witnessed
  delegation/physical UAC remain **NO-GO**.

`CORE_EXECUTOR_DISPATCH_ENABLED=false` and standard `shell.exec` is not
 elevated. Broad CORE/ROOT commands remain source-only preapproval design.
