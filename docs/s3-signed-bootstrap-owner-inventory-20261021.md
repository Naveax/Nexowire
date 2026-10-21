# #551 owner: signed CORE installer stage and Broker bootstrap graph integrity
2026-10-21 | staged owner branch based on #632 (`ea4229b9ed34c06f5bcb0d52048b25f591cbb040`)

## Independent QA review

- QA worker #20 PR #639, source-only negative tests. HEAD
  `35acaf6cc97778f3e0aa99bd90378e9c2f251cff`. Its earlier SHA
  `1cf3d164...` had a TS fixture literal-type error, corrected at
  exact new SHA; CI run #39625620173 SUCCESS. 12 top-level synthetic
  tests cover publisher/certificate, signed old rollback, ACL + Deny
  inheritance, reparse/missing import, SYSTEM token, DPAPI owner key,
  one Windows owner consent versus remote click, revoked CORE and UNKNOWN.
- QA worker #28 PR #644, HEAD
  `669e0779562e15f8b5f22306eb0d5c4f06eca71f`,
  exact CI run #39627727657 SUCCESS. 10 negative source scenarios
  cover eight crash phases, installation/rollback forged signatures,
  stale DPAPI, wrong Agent1.0.5/Hub version, independently witnessed
  revoke and false stop/rollback readback.
- These independent QA files stay untouched by #12 owner changes.
  Neither QA proves a real Authenticode-signed Nexowire installer,
  a physical Windows VM rollback, local UAC approval or a protected
  live high-token process.

## The actual source gaps addressed in owner code

Earlier #551/#632 had isolated signed target/rollback fixtures and
ACL/TASK/DPAPI fixtures, but no **complete signed protected stage graph
linked to the active owner enrollment and scheduled Broker action**.

The owner implementation now adds two read-only source checks:

1. `assessProtectedCoreInstallerStage`
   (`scripts/s3-core-broker-install-gate.ts`)
   independently checks a strict Ed25519 manifest with its
   out-of-band pinned public key and exact canonical SHA256, owner,
   device, transaction and target/prior Broker versions. A fully
   enumerated recursive native staging readback is required for
   installer, Broker, signed helper, updater, complete old rollback
   executable, every imported executable/DLL and resource/config
   discovered. Reject missing/extra files, duplicate normalized paths,
   duplicate native volume+file identity (hardlink aliases), renamed
   files, cross-volume substitution, reparse, tampering or incomplete
   import closure. Confirm every staged path AND ALL ancestors
   have protected inherited/explicit ACL, including updater and
   parent replacement paths. Each executable, including rollback and
   imported DLLs, must pass exact Authenticode Subject, independently
   pinned DER certificate SHA256 and file SHA256. Config/resource
   digests remain bound by the signed manifest.
   Read-only native Authenticode inspection is available as the
   default provider; tests inject deterministic fake evidence.
2. `assessCoreLinkedStageAndDelegation`
   (`scripts/s3-core-bootstrap-delegation-audit.ts`)
   cross-checks stage owner/device/transaction, publisher pin,
   signed Broker/updater/installer/rollback digests against the
   OS-authenticated Task Scheduler action, actual running image
   identity, DPAPI owner binding, one Windows local installation
   consent receipt and prior signed Broker recovery identity.
   Every signed imported resource/DLL must belong to the protected
   task/import list. This blocks joining two independently plausible
   but DIFFERENT signed source snapshots to fake one valid enrollment.

## Truthful boundaries, NO-GO

Even fully passing synthetic stage and enrollment still return
`actuallyInstalled:false`,
`initialLocalUacApproved:false`,
`elevatedCommandMayExecute:false` and
`productionApproved:false`.
No native Windows installer, Windows UAC consent UI interaction,
Secure Desktop automation, elevated service, DPAPI key unwrap,
Task Scheduler registration, protected ACL mutation or VM mutation
has been performed. This is source-only preflight and architecture.

The complete import list and volume+file identities are supplied by
an injected inspector; an authenticated kernel-native provider
capable of securely pinning handles and all dynamic imports is NOT
implemented. The read-only snapshot does not guarantee an atomic
protected cutover or eliminate TOCTOU. Independently durable journal,
external epoch/CAS authority and real local Windows OS consent remain
required before production.

CRITICAL #271: live `C:\ProgramData\NexowireStack`
privileged imported code still inherits `Authenticated Users: Modify`.
This is a production hard no-go. Do not turn on #617 CORE elevated
dispatch, merge/deploy #596/#608 or run native installer until that
physical privilege boundary and signed Agent1.0.5 rollback have
independent acceptance. Work PC and Naveax Agents remain unchanged.
