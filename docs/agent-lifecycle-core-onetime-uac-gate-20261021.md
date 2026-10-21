# #551 / #617 CORE one-time owner-UAC Broker installation: source acceptance
21 October 2026 | isolated S3 lifecycle branch | PRODUCTION NO-GO

## Owner correction to #617 and relationship to #618

The user's **CORE/ROOT (R00T)** intent is NOT to present UAC on every
administrative command. The missing Windows privilege boundary is:
1. A trusted native installer with exact independently pinned publisher,
   Authenticode certificate DER SHA-256, file SHA-256 and signed manifest
   stages the protected Broker/helper/import tree and the COMPLETE signed
   old rollback archive in an administrator-protected slot.
2. Windows local owner (or independently authorized Windows remote/admin
   session) approves installation through supported Windows UAC. Do NOT
   auto-click, spoof, disable, switch to or bypass Secure Desktop. A remote
   ChatGPT/browser 'approved:true', consent.exe presence or lost ACK does
   not constitute Windows consent. Remote sessions can only rely on what
   Windows natively permits; if secure UAC desktop is not accessible from
   the authorized session, mark APPROVAL_REQUIRED/BLOCKED, do not bypass.
3. The Windows-native installer verifies protected effective ACLs of
   executable, parent replacement paths, DLL/import graph, config and
   updater, then atomically launches/registers an owner-scoped Broker
   with **genuinely high/elevated effective Windows token**, enabled
   BUILTIN\Administrators SID (NOT deny-only), OS image-handle identity,
   verified process start and authenticated version-matched handshake.
4. Subsequent owner-authorized CORE requests route through that *already
   running* verified high-token Broker without repeating UAC each command.
   The caller's FULL/CORE/ROOT preference is only an intent signal. A
   Medium shell.exec does not magically become elevated and generic
   remote shell permission must never bypass Broker authorization.
   Administrative capabilities require separate signed owner/device
   scope, strong session auth and immutable audit/replay authority.
   Hyper-V uses exact VM GUID-scoped typed operations; it must not
   become a generic elevated shell through #617.
5. Revoke, stale epoch, foreign owner/device, ambiguous UAC consent,
   crashed startup, cutover/rollback UNKNOWN and missing independent
   native process identity -> stop, no automatic replay. Actual prior
   signed rollback bytes must be protected and verified before recovery.

PR #618 belongs to the #04/Admin Bridge owner and is a read-only
user-visible privilege/evidence explanation. It cannot install a
Broker or grant real elevation. This #12 work owns only signed release
trust, installer/rollback gate and source-only negative tests.
No #618 source files were changed.

## Added #551 source test and acceptance module

scripts/s3-core-broker-install-gate.ts defines a non-executing
one-time-install contract wrapping the existing independently signed
Broker/helper/updater, exact owner/VM GUID enrollment and ACL gate.
It additionally requires independent signed/pinned installer and
prior-version rollback binary inspection, version alignment,
protected installer + rollback + all explicitly listed imports and
their Windows drive-root ancestors, fresh independent revoke epoch,
Windows local consent provenance, and elevated **effective** token:
- TokenElevationType.Full / actual TokenIsElevated TRUE
- integrity RID >= 0x3000 (High; System above High)
- enabled Administrators SID S-1-5-32-544, not deny-only
- device-bound process creation identity, native image handle and
  exact running image SHA256 from trusted native Windows evidence.

Read-only fixture tests demonstrate fail-closed:
- Medium (0x2000), deny-only Admin, false elevated, fake PID/image
- remote UI / consent.exe / forbidden secure-desktop click evidence
- writable or missing installer/parent/updater/import, reparse, owner
- unsigned or forged helper installer, wrong publisher/cert, old rollback
- 1.0.4/1.0.5 prior Broker mismatch, Agent mismatch, bad migration
- owner revoke, replayed/stale epoch, startup UNKNOWN and no replay
- independently supported local console versus authorized Windows
  remote/admin session, neither implies actual UAC can be automated.

IMPORTANT: Test inputs include synthetic Ed25519 signatures and injected
test Authenticode/Windows-native token responses. They ARE NOT a
signed Windows native installer, genuine local UAC consent receipt,
real elevated native process handle or a physical VM rollback test.
Even an entirely valid fixture returns:
  status = source_preflight_only
  mayInstall = false
  mayExecuteCoreAdmin = false
  productionApproved = false
  subsequentCoreUac = no_reprompt_architecture_only

## Unresolved production gates (NO-GO)

- #271 actual elevated legacy ProgramData tree inherited
  Authenticated Users Modify; owner/effective ACL remediation,
  parent/updater/import TOCTOU and physical write-denial outstanding.
- #551 first-party Nexowire Authenticode-signed physical installer,
  trusted native helper and full Agent1.0.5 signed rollback archive
  + immutable installer/cutover/anti-rollback journal unavailable.
- Actual Windows-native GetTokenInformation high token, enabled
  admin SID, verified running signed image and local Windows installer
  approval need an isolated authorized Windows VM/canary.
- #617/#323 signed owner intent, authenticated Broker version handshake,
  physical Windows approval and capability-level dispatch unimplemented.
- #618 read-only evidence is NOT elevated Broker acceptance.
- No real UAC/ACL/service/VM mutation, no Start-VM/Stop-VM,
  no deploy/merge #596 or #608 and no production installer execution.

Detailed isolated source evidence lives in
test/s3-core-broker-install-gate.test.ts and
test/s3-hyperv-broker-trust.test.ts. Their green result is a SOURCE
test acceptance only. Exact-head GitHub CI and Release Readiness
must be reported separately from physical Windows deployment.
