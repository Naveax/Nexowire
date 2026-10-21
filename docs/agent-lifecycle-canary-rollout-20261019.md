# Nexowire S3 Agent Lifecycle: canary and rollback acceptance ledger

Date: 2026-10-19. Scope: PR #551, isolated source and read-only physical inventory.

## Verified boundaries

- SOURCE TESTED: unit/fixture acceptance, TypeScript/build; not installed runtime.
- PHYSICAL READ-ONLY: Work PC and Naveax Agent 1.0.5 installation fingerprints matched.
- DISPOSABLE VM: BLOCKED. Work PC Get-VM returned ACCESS DENIED; VirtualBox unavailable. No authorized disposable VM tested.
- NEXOWIRE SIGNED INSTALLER: BLOCKED. Current Setup.cmd, its release checksum and signed Node runtime do not prove a first-party Nexowire Authenticode signature.
- PRODUCTION: BLOCKED. No signed old rollback archive, independent production release certificate/key pins, durable external journal or immutable protected file-handle cutover.

No crypto/model worker, actual Agent upgrade, real service restart or production change was performed.

## Two independently checked installed Agent 1.0.5 fingerprints

Both Work PC and Naveax reported LocalAppData/Nexowire/versions/1.0.5-a75d0d6c040b.

| Installed relative file | Bytes | Actual SHA-256, both devices |
|---|---:|---|
| app/package.json | 2755 | 9289df0813cfb5ba53fa828f804f8ff421744177d4defc4aa167fab129a52435 |
| app/dist/src/cli.js | 7993 | c99081a1c6bddc5d5faae567a545b7d332a9d2b827f03084ff131aad9288e649 |
| BUILD.txt | 81 | 6ecb11662ba266d9fcbf61194e643c27aedec9c4448ead4a9b592a6658d80f9b |

These are FILE hashes, not an installable signed rollback archive.

Missing mandatory rollback fields:
- complete signed original version 1.0.5 rollback archive SHA-256: UNKNOWN / BLOCKED
- complete signed target installable artifact SHA-256: UNKNOWN / BLOCKED
- independently pinned Nexowire signing certificate DER SHA-256: UNKNOWN / BLOCKED
- independently pinned Nexowire Ed25519 manifest public key: UNKNOWN / BLOCKED
- signed old/target manifest SHA-256 and source provenance: UNKNOWN / BLOCKED
- ACL-protected rollback directory and atomic file-handle evidence: NOT TESTED
- external crash-persistent, fsynced transaction journal: NOT IMPLEMENTED IN PRODUCTION

Never infer a complete package hash from three installed file digests.

## Gate: signed cutover and safe rollback

A trusted release operator must independently pin two signed releases (old and target), Ed25519 public verifying key, exact publisher subject and Authenticode DER certificate digest. Agent/Hub versions and owner, device, authentication epoch, token-validity, CORE and Admin Bridge grants must be independently read.

BEFORE STOP: verify signed old and target manifests, actual payload SHA-256, first-party Authenticode identity, Hub compatibility for BOTH target and rollback, disk and explicit operator permission. Stage in protected rollback/target slots; rehash each slot and recheck trusted owner/epoch/privileges immediately before disruption.

AFTER FAILURE: rehash rollback slot again before execution. A corrupted rollback EXE must never run. Accept rolled_back only after old Agent version + exact process identity + Hub version + valid owner/session/token/CORE/Admin Bridge proof. Any missing data means rollback_unconfirmed, not success.

CRASH RECOVERY: an external durable fsynced journal is mandatory. If the host crashes after stop or after launcher cutover, never accept PID/port alone, never replay UNKNOWN mutations, and do not consider in-memory fixture rollback equivalent to real crash recovery. Production implementation is still BLOCKED.

## Disposable VM matrix, planned and NOT executed

| Scenario | Mandatory VM experiment | Required outcome |
|---|---|---|
| Bad/unsigned installer | Corrupt signed binary and try unsigned file | DENY before stop; no implicit UAC approval |
| Wrong publisher or cert | Sign another executable with a different trusted vendor | DENY exact independently pinned signer |
| Replaced manifest | Corrupt Ed25519 bytes, change source and artifact digest | DENY before stop |
| Hub incompatible | Old/new Hub outside both signed Agent bounds | DENY before stop |
| Token revoke | Revoke token after staging / rotate login epoch | DENY and no privilege escalation |
| Update crash | Stop VM after signed stage, after stop, after cutover | Durable recovery or UNKNOWN, never false success |
| Failed health | Wrong process/device or nonresponsive ready endpoint | Hash-verified rollback or rollback_unconfirmed |
| Corrupt rollback | Tamper original rollback EXE after target failure | Never execute it; rollback_unconfirmed |
| Double update | Repeat same invocation after reconnect | Owner-scoped CAS lock; no duplicate mutation |
| Windows UAC/AV | Non-admin Windows 10/11 user, denied UAC, AV quarantine | Safe failure; no bypass |
| Repair/uninstall | Interrupt and restore without losing credentials | No silent CORE/ROOT/Admin Bridge reset |

Each physical VM run requires an authorized VM/snapshot ID, exact old/target binary SHA-256, independently authenticated publisher/cert, signed manifests, exit codes, security/health logs, original worker identity, rollback hash and post-rollback validation. Local temporary Node fixtures do not satisfy the VM gate.

## Canary rollout phases (NOT authorized to execute)

1. Source gate: exact-HEAD CI, security review, first-party signed installer and signed old/target manifests independently verified. No production credentials embedded.
2. VM gate: clean-user Windows 10 + 11 isolated VMs, positive/negative matrix, actual power interruption and recovery journal, version & broker authority preserved.
3. Staging gate: only named isolated endpoints, verified owner+device, immutable protected artifact storage, preflight and rollback supervisor. Do not change production DNS/tokens.
4. Canary gate: explicit new owner approval for a NONPRODUCTION canary only. Do not touch Work PC or Naveax daily Agents.
5. Observation gate: exact process creation identity, signed on-disk binary, authenticated health, requestId reconciliation, no unknown retries, rollback health after forced failures.
6. Production gate: separate approval only after VM and canary acceptance, staged one-device rollout with full rollback evidence.

Decision: SOURCE FIXTURE TESTS ONLY; VM BLOCKED; SIGNED_INSTALLER BLOCKED; ROLLBACK_BUNDLE BLOCKED; PRODUCTION BLOCKED; NO LIVE ROLLOUT.


## 2026-10-20: offline installer cryptographic gate and #588 release dependency

PR #551 now additionally provides an OPERATOR-ONLY and READ-ONLY
two-release preflight, implemented in:
- scripts/s3-release-bundle-audit.ts
- scripts/verify-s3-release-bundle.ts
- test/s3-release-bundle-audit.test.ts
- test/s3-release-cli.test.ts

Use only after a separately authorized release team provisions all the
real Nexowire-owned signed binaries, signed Ed25519 manifests, and an
OUT-OF-BAND trusted policy/digest:

    npm run s3:release-preflight -- --trusted-policy "C:\operator\policy.json" --policy-sha256 <out-of-band SHA256> --bundle-root "C:\staging\release"

The trusted policy JSON must have:
- schemaVersion=1
- trustedManifestPublicKeyPem (Ed25519, separately issued)
- trustedPublisher (exact Authenticode signer Subject)
- trustedCertificateSha256 (SHA256 of DER signing certificate)
- expectedOwnerAccountId, expectedDeviceId
- installedAgentVersion, targetVersion, hubVersion
- targetArtifactSha256, rollbackArtifactSha256

Under the isolated release bundle root:

    target/installer.exe
    target/manifest.json
    target/manifest.sig
    rollback/installer.exe
    rollback/manifest.json
    rollback/manifest.sig

Manifest JSON uses the strict S3 SignedAgentManifest schema and exact
canonical Ed25519 signature encoding used by agent-lifecycle-manager.ts.
The trusted policy file digest comes from the OPERATOR OUTSIDE the
release archive. A policy and its own checksum downloaded from the same
untrusted GitHub release would be circular and is NOT accepted as a
real independent root of trust.

The CLI inspects actual native Windows Authenticode for the target and
rollback installer.exe and cross-checks independently pinned publisher
Subject, DER certificate hash, exact release bytes/hash, strict signed
Ed25519 manifest, target/old version identity and BOTH Hub compatibility
ranges. All material is read bounded, without launching any executable,
installing services, prompting UAC, updating a device or invoking a Hub.

A successful report explicitly includes:
- status: offline_artifacts_verified
- canaryApproved: false
- productionApproved: false
- executionSafe: false

Even if the offline binary passes, this DOES NOT establish the OS
process image identity after a mutable file-path cutover, protected
ACL/handle, rollback restart identity, owner authenticated health, UAC
consent, durable fsynced transaction journal, VM restore or live canary.
Production launch remains strictly BLOCKED. In the absence of real
independently signed Nexowire installer and retained complete old
rollback package SHA256, this CLI must fail closed.

The isolated upgrade adapter now also REQUIRES an OS-trusted binary
attestation: installed artifact SHA-256, actual running image SHA-256,
stable process-creation identity and authenticated health receipt.
A PID, TCP port, worker-reported binary name or version alone does
not satisfy that source contract. The real OS attestor remains unbuilt;
fixture attestation is only a source acceptance test.

### #588 coordination/deployment gate

Issue #588 file transfer is owned by Artifact Bridge (#08), file grants
(#05), reconnect (#06), QA (#16) and integrator (#00). PR #551 DOES NOT
alter stream code, message size, quotas, chunks, resumable sessions or
owner authorization. A source-only #588 implementation must not be
represented as live on Work PC/Naveax, which still advertise Agent
1.0.5. A signed, pin-verified, staged, rollback-safe rollout with
version-negotiated Hub and native Agent acceptance is mandatory before
claiming its large-file streaming capabilities work in production.

### Two-device staged release rule

First run the isolated signed Windows 10/11 VM matrix, including
damaged installer, wrong publisher, wrong Hub, revoke, crash-at-cutover,
false-positive health, failed rollback, durable restart recovery and
restored signed OLD SHA256. Only AFTER a successful nonproduction first
canary and a separate explicit approval may the second canary proceed.
A test double that calls stage/cutover for only one fictional device
does not establish this gate for real Naveax or Work PC.

DO NOT update or restart Agent/Broker on Work PC or Naveax from this PR.
DO NOT run nexowire.update.apply or activate future #588 features.
The first-party Windows-signed installer and real VM recovery evidence
are currently unavailable: PRODUCTION NO-GO.


## 2026-10-20 late: root P0 #271 ACL-integrity preflight

GitHub issue #271 records that elevated legacy Nexowire Stack code under
C:\ProgramData\NexowireStack inherited NT AUTHORITY\Authenticated Users:
Modify on the executable/import path. ADMIN file ownership alone is
NOT an effective integrity guarantee.

This S3 branch adds operator-only READ-ONLY
scripts/s3-windows-acl-preflight.ts. The operator release audit now
requires an ACL inspection of both target and retained rollback trees
and their drive-root-to-target ancestors BEFORE inspecting/managing
signed binaries. The scan uses a fixed Windows PowerShell OS executable
under System32 and reads NTFS owner, inherited+explicit ACEs,
reparse/symlink bits and recursively enumerated files. It rejects:
- unknown/untrusted owner SID, unresolved principal SID, reparse point,
  duplicate nodes, oversized/unavailable/incomplete enumeration;
- ANY Allow ACE granting a write/append/delete/write-DAC/write-owner/
  generic-write or full-control bit to a principal other than SYSTEM
  (S-1-5-18) or Administrators (S-1-5-32-544), including inherited
  Authenticated Users, Everyone and BUILTIN Users.
- explicit Deny is NOT counted as a safe override for a conflicting
  unprivileged Allow; effective group/token privileges are not proved.

The scanner is intentionally conservative; a legitimate custom updater
service identity needs independently reviewed delegation policy, not
a silent allowlist exemption. This scan cannot prove SYSTEM's future
effective token, every dynamic import, ACL-protected atomic launch or
fully prevent TOCTOU after inspection. Its result always includes
executionSafe:false and productionApproved:false. It NEVER changes
any ACL, file, task, Agent or Broker. All ACL migration/remediation,
full live import-chain inventory and privileged integrity acceptance
remain under the P0 #271 owner, NOT #551.

Tests include source snapshots of #271 inherited Authenticated Users
Modify and writable parent, conflicting Deny+Allow, reparse/unknown
owner/unprivileged sid, scan fail-closed; real Windows read-only NTFS
scans ONLY of temporary USER-WRITABLE directories reject preflight.
Production release cannot launch from those writable roots even if
a synthetic certificate-inspector fixture claims a valid signature.
No live legacy runtime security configuration was changed.

Dependency gates: #271 privileged ACL repair/provenance must be
physically reviewed with approved elevated authority, and signed
Nexowire-owned installer plus complete signed Agent 1.0.5 rollback
package must be available with OUT-OF-BAND pins. Before staging #588
large-file streams or #598 bounded HTTP messages on a real Agent,
require successful Windows 10/11 isolated signed-install/rollback VM
crash acceptance, explicit ownership, compatibility and safe canary.
#551 adds source tests, not the actual Windows installer or VM evidence.
Both real Agent 1.0.5 devices remain unchanged. Production NO-GO.


## 21 October 2026: separately signed helper and crash/restart freeze

The offline signed installer package is now a THREE-artifact trust contract:
1. target/installer.exe, target/manifest.json, target/manifest.sig
2. rollback/installer.exe, rollback/manifest.json, rollback/manifest.sig
3. helper/installer-helper.exe (separate helper, never assumed signed
   simply because an Agent binary or Microsoft Node runtime is signed).

Trusted policy supplied independently of release downloads MUST include
installerHelperSha256 (64 lowercase SHA-256 hex) in addition to the
target and rollback artifact SHA-256, trusted Ed25519 manifest public
key, exact Authenticode Subject, signing certificate DER SHA-256,
target/prior Agent versions, current Hub version, account owner and
device identity.

Source audit first verifies protected ACLs of helper, target and
rollback roots, then independently SHA-256 checks helper and calls
native Windows Authenticode with exact publisher Subject and cert pin.
It rehashes helper after inspection, then checks signed target and
rollback manifests and native Authenticode. Missing helper, modified
bytes, unsigned helper, wrong certificate/publisher, user-writable
helper ancestor/contents, wrong source-version identity or tampered
independent policy hash = fail closed.

The synthetic fixture tests use an injected fake signature inspector,
not a Nexowire production-signed helper. Real Windows Authenticode OS
API is tested separately in test/windows-binary-trust-s3.test.ts.
No actual Nexowire-signed helper/installer was available. The source
preflight always returns executionSafe:false and productionApproved:false.

scripts/s3-crash-recovery-assessment.ts is an ISOLATED fail-closed
crash/restart decision helper. It validates exact installation
transaction, old/target Agent versions, owner/device, Hub, independently
pinned old/target/helper SHA-256 and an external monotonic minimum
sequence. It deliberately returns NO_AUTOMATIC_RESTART_OR_ROLLBACK for
every valid crash phase, even a signed_stage_ready snapshot, because
local disk and installer journal can be co-rolled back. Truncated
journal, stale sequence, wrong old version, owner/device mismatch
and hash drift likewise deny. This is NOT a durable journal
implementation, NOT native Windows process attestation, NOT a VM
reboot/restore test and NEVER restores or restarts a live service.

Physical acceptance still needs a first-party Authenticode signed
native helper and installer, full signed Agent 1.0.5 rollback
archive/hash, independently stored durable monotonic transaction
authority, protected ACL/parent write-denial #271, exact binary
file-handle/process identity, disposable Windows VM crash/restart
tests and two-device staged canary. Until proven, #596/#608 rollout
and production remain NO-GO. Live Work PC and Naveax unchanged.
