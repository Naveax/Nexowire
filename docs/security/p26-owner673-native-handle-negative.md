# P0 Worker 26: #657 versus #673 native provenance hostile QA

**DRAFT / SOURCE QA ONLY. Do not merge or deploy as physical CORE or filesystem acceptance.**

## Exact parent and ownership

- Owner #673 HEAD: 2c78cedc6ee9ce6ebc0f5de635de47a6bcdcc449, stacked on #553. Hosted CI run 39632538963 was SUCCESS when independently checked.
- Prior #26 #657 HEAD: 561af65b6cc1659f413bf11918b4ff356738c960. Hosted CI run 39630539339 was SUCCESS when independently checked.
- New child QA branch is based on #673 HEAD; PR must target #673's owner branch. This permits importing the **actual** #673 boundary policy without copying or editing production code.
- QA-only files: test/p26-native-owner673-adversarial.test.ts and this document.
- All tangible objects are created within disposable Windows TEMP test directories. No installed Agent or Broker, UAC, OS ACL modification, USB, user files, VM, ReVoltVPN-Ubuntu-Lab or elevated service.

## Adversarial evidence matrix

| Vector | Evidence | Boundary consequence |
| --- | --- | --- |
| Junction renamed while a no-follow Windows handle stays open; original path recreated as junction targeting another temporary directory | Native TEMP CreateFileW with OPEN_REPARSE_POINT, GetFileInformationByHandle and GetFinalPathNameByHandleW | Original held file ID remains stable but current pathname has a different reparse object and target. Fresh source/parent path/reparse/identity checks must DENY. |
| Hardlink in foreign TEMP owner scope and ADS on original file | NTFS hardlink, named ADS, OS-open handle identity | Same file ID is not approval for another pathname, stream, owner or link count. |
| Stale source or destination parent after rename/reparse/volume changes | Direct synthetic negative evidence passed to actual #673 assertNativeProtectedFileBoundary | FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED expected. |
| Protected parent, updater and module source ACL and signer failures | Independent hostile provider-unavailable, untrusted ACL owner/write, missing signer/digest, replaced handle, reparse | FILE_NATIVE_PROTECTED_ACL_UNVERIFIED or FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED expected. |
| Protected updater DLL with no separately attested transitive import record | Inject extra test-only field injectedDllAttested=false while source witness boolean stays true | **EVIDENCE GAP**: actual #673 policy still accepts. Source contract has no per-DLL import DAG identity/provenance to verify; synthetic boolean is NOT physical Authenticode/ACL attestation. |
| Sparse logical 4 GiB+ metadata | Pure BigInt arithmetic beyond uint32 offset range, one 32-byte digest seed, invalid range checks | No uint32 truncation, unsafe precision or allocation. Physical read/write beyond 4 GiB is NOT proven. |

## Verification and limitations

Run in a clean separate Windows checkout at the final PR SHA with dependencies installed:

~~~powershell
node --test --import tsx test/p26-native-owner673-adversarial.test.ts
node --test --import tsx test/p05-native-source-handle-acl-negative.test.ts test/broker-filesystem-preflight-negative.test.ts
npm run typecheck
npm run build
npm run continuation:check
git diff --check 2c78cedc6ee9ce6ebc0f5de635de47a6bcdcc449...HEAD
~~~

Two kernel32 TEMP fixture cases skip on non-Windows; all four source-only cases run on all supported platforms. Hosted CI is not Windows test execution proof unless it actually runs this file on the Windows runner. Preserve exact-head CI FAIL or IN_PROGRESS as observed; do not rerun a queued or in-progress same-SHA workflow.

### Production NO-GO

The current #673 native source witness is a source contract, not a wired independently authenticated native OS observer. Neither stable GetFinalPathNameByHandleW nor a positive synthetic provider flag makes post-preflight mutations atomic. #05 owner must add actual protected per-import DLL publisher/digest and ACL graph proofs, current owner/device epoch and atomic handle-relative I/O. External durable CAS/write receipt is #08-owned. Protected parent ACL #271, signed bootstrap #551, live Agent 1.0.5/CORE high-token and physical USB remain BLOCKED. Do not merge or deploy based on these tests.
