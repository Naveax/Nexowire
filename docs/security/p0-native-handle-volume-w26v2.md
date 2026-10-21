# W26 v2: Windows handle volume provenance and cross-scope negative QA

**SOURCE-ONLY / DRAFT / NO PRODUCTION ACCEPTANCE.** This is a second isolated QA PR, independent of W26 #647, #05 filesystem owner #553 and #08 cross-device transfer #634. No owner implementation, live service, Agent/Broker, UAC, machine ACL, removable USB, user content or VM is touched.

## Evidence baseline and exact branch

- Repository: Naveax/Nexowire
- Branch: `qa/w26-native-handle-volume-v2-20261021`
- Base main: `754cc4364822be5fda528f54042fb22a84f19924`
- File added: `test/p0-native-handle-volume-w26v2.test.ts`
- This is not a modification to #647 or #553.
- All native test files, hardlinks and alternate streams are generated under a unique `os.tmpdir()` directory and cleaned after each test.
- The fixture invokes Windows PowerShell only to load disposable **read-attributes-only kernel32 P/Invoke code**: `CreateFileW`, `GetFileInformationByHandle`, `GetFinalPathNameByHandleW`, `GetVolumePathNameW`, `GetVolumeNameForVolumeMountPointW`. No elevated token or ACL operation.

## Independent security matrix

| Vector | Evidence asserted | Trust boundary and negative |
| --- | --- | --- |
| Rename and pathname recreation | A retained `CreateFileW` handle has a stable file ID but `GetFinalPathNameByHandleW(VOLUME_NAME_GUID)` follows the renamed file; the recreated old name has a **different** file ID | Old path-scoped owner grant cannot be reused for the moved handle when crossing from `owner-approved` to `different-owner-scope` |
| Volume identity | `GetFinalPathNameByHandleW(VOLUME_NAME_GUID)` prefix agrees with independently queried `GetVolumeNameForVolumeMountPointW` mounted volume GUID | Do not treat a drive letter or a caller-provided volume string as authoritative; actual USB detach/reletter and non-atomic mutations **not exercised** |
| Hardlink and ADS | NTFS original, hardlink in another temporary delegated root and named alternate data stream have a common NTFS file ID; each resolves to same actual volume | Matching file ID and volume do **not** imply permission for different path, owner, device, revoked epoch or stream |
| 4 GiB virtual offset | BigInt values above 2^32 are compared against uint32 truncation; 64 KiB cap, negative/range overrun and unsafe >2^53 are rejected | **Metadata only**: no 1 GiB/4 GiB file allocation or native large-file I/O |
| Short read | A tiny TEMP source requested as a 64 KiB interval returns `PARTIAL_READBACK`; no final artifact exists | Partial bytes and digest cannot be advertised as complete |
| Cancellation while a short read is pending | Deterministic after-read gate; cancellation before validation gives `CANCELLED`, leaves verified digest unset and destination absent | No timers/sleep; no simulated partial I/O falsely counted as published |

**Caution:** `ScopedGrant` and `accept()` are intentionally independent *synthetic* policy oracles. They do **not** assert that native filesystem DACL checks enforce these owner/device grants or that the existing Agent integrates this authorization at mutation time. These TEMP tests do not authenticate a real user token, impersonate a different user, or modify NTFS security descriptors. Both generated directories remain under the same real Windows logon account.

## Commands

From a clean, independent clone at the exact PR head, with dependencies installed:

```powershell
node --test --import tsx test/p0-native-handle-volume-w26v2.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check 754cc4364822be5fda528f54042fb22a84f19924...HEAD
```

Local source acceptance and hosted CI must cite the **final** committed SHA separately. Never transfer #647's CI verdict to this PR. If hosted Windows `browser-live` fails in unchanged `test/windows-job-owner.test.ts`, report the actual job and assertion without skipping or restarting the same SHA.

## Remaining physical P0 blockers

1. #05 native owner needs verified atomic handle-relative operations with OS-authoritative volume/file/stream/reparse identity, verified active owner/device/grant epoch and real token/ACL outcomes immediately before mutation.
2. #08 cannot treat a Hub assertion, lost ACK or synthetic staged digest as a physical writer fence; a genuinely trusted Native atomic CAS/epoch and independent readback are required.
3. Real Agent 1.0.5 still lacks accepted physical >256 MiB path, and real USB detach/reletter, encrypted/remote volumes, signed installed worker, permission failure and cancellation race acceptance remain **BLOCKED**.
4. No merge/release based on this synthetic source-only PR. Get #05/#08 owner review and #00 integration plus authorized physical canary evidence.

**Safety:** no ReVoltVPN-Ubuntu-Lab; no Start-VM/Stop-VM; no Agent/Broker/UAC/ACL/service mutation; no user files; no 1 GiB allocation.
