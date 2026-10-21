# Worker #26: #694 versus #690 transitive updater DLL negative QA

**DRAFT / SOURCE QA ONLY / NOT PHYSICAL ACCEPTANCE.**

## Exact ownership and parent

- #05 owner #690: b0e0fb30d908cc255e60cb30dedb4b6099e2c646, GitHub Actions 39644754728 SUCCESS.
- #26 predecessor #694: 76a88b22a76d72d1824559dbd4f741c7f2da1b7d, Actions 39645047557 SUCCESS.
- New #26 branch: qa/w26-p690-import-dag-20261021, stacked directly on #690 and targeting its branch; no #05 source/test owner edits.
- Added QA-only test: test/p26-owner690-transitive-import-native-negative.test.ts.
- Separate exact-head hosted CI is required. Do not inherit either earlier SUCCESS.

## Evidence matrix

| Threat | New independent test | Evidentiary limit |
| --- | --- | --- |
| Per-DLL imported dependency spoofing | A test-only three-node updater.exe -> stage.dll -> nested.dll manifest requires each node's publisher, SHA-256 digest, independently pinned file ID, volume, final handle path and import edges. Single-node publisher/hash/file ID/volume/path substitution, alias, missing/extra/orphan nodes, edge changes and cycle all throw. | Publisher value is synthetic; not a real Authenticode signature or real import table parser. Test oracle is not #05 production. |
| #690 import graph omission | Pass a synthetic protected updater witness with role-wide pinnedPublisherAndDigest=true and an extra unauthenticated transitive DLL marker through the **actual** #690 assertNativeProtectedFileBoundary. It accepts: **a known source-contract evidence gap**, not demonstrated live privilege elevation. | A protected OS witness producer, per-DLL manifest/ACL/signer attestation and installed Agent are NOT wired. |
| Parent/updater/module ACL and root grant | For each #690 protected role, unavailable effective ACL, untrusted DACL write ACE, replaced handle ID and reparse tag reject. A mismatched grant-root volume is denied by authorizeNativeRelativeChain. | All DACL, grant and owner witnesses are synthetic. |
| Hardlink and ADS | Disposable TEMP DLL/hardlink/ADS use real Windows CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT), GetFileInformationByHandle, GetFinalPathNameByHandleW. Same NTFS file ID despite different alias or named stream; a link count >1 cannot be accepted as a unique protected imported DLL. | Files only in unique TEMP folder, current logon account. No real user ACL or signed DLL verification. |
| Junction rename/retarget | Read-only native handle stays pinned to the renamed old TEMP reparse object; recreating a junction at its old path points to a different physical object and module contents. | Native identity probe only. Preflight cannot authorize a later pathname-based write; atomic relative Win32 mutation still missing. |
| 4 GiB sparse-offset precision | Metadata-only BigInt >2^32 checks, 64 KiB per-range maximum, u32 truncation, negative/out-of-range and >2^53 rejection; only 32-byte digest seed allocated. | No 1 GiB/4 GiB allocation, no physical sparse file, no disk-bound 4 GiB read/write. |

## Windows isolated commands

Run from an independent checkout with the exact branch commit:

~~~powershell
node --test --import tsx test/p26-owner690-transitive-import-native-negative.test.ts
node --test --import tsx test/p05-native-relative-effective-acl-negative.test.ts test/p05-native-source-handle-acl-negative.test.ts test/broker-filesystem-preflight-negative.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check b0e0fb30d908cc255e60cb30dedb4b6099e2c646...HEAD
~~~

The two Windows TEMP native tests skip on non-Windows CI. A Linux Node workflow PASS must never be described as real Windows physical probe execution. Maintain a separate local-Windows evidence record.

## Production NO-GO

#05 must implement a trusted OS-native authenticated producer of independently pinned **every imported DLL** file handle, publisher, digest, reparse status, protected parent and full import graph before treating it as executable trusted source. #690 effective ACL and relative directory handle **source contracts** alone do not establish live Win32 ACL/Authenticode or irreversible file mutation durability. No high-token Broker, installed Agent 1.0.5, physical USB, production ACL, UAC, service, user files, ReVoltVPN-Ubuntu-Lab, VM, or #08 Artifact owner store is touched. Do not merge or deploy on this QA alone.
