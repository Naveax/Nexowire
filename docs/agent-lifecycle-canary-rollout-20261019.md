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
