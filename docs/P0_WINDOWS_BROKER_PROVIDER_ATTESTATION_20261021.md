# P0 #03 — Windows Job and signed high-token Broker provider evidence

**Scope:** isolated source-only QA, child of CORE/ROOT PR #633.
**Decision:** production NO-GO; elevated CORE executor dispatch remains DISABLED.

## Exact failure provenance

- #633 exact HEAD `c429ed9c7eb6de45c4c1ae8de67b528f940fe3ab`: GitHub CI and Release Readiness **SUCCESS**.
- #629 exact HEAD `19ac7fc42f482c4cd3c019f46ac7af1db05ec626`: CI `39608916753` Windows `browser-live` **FAILURE**. Specific negatives:
  - `test/windows-job-helper-acl-publisher.test.ts`: real signed test surrogate reports `authenticodeStatus=UNAVAILABLE`, not expected `Valid`.
  - Its temp inherited ACL Modify test reports `parentBroadWriteGrantFound=null`, not expected `true`.
  - Fast-exit is not the failure in this run. An independent 100-cycle stdout ordering QA passed elsewhere, but that does not attest file/publisher security.

## Native signature and ACL evidence, no fake success

`scripts/audit-windows-job-helper-trust.ps1` now loads the genuine `Microsoft.PowerShell.Security` module by its absolute protected `$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1` path and calls its **module-qualified** `Get-AuthenticodeSignature`. Caller-defined functions **and a malicious same-named module earlier in `PSModulePath`** cannot simulate `Valid` or ACL protection. If the pinned genuine provider cannot be established, evidence remains `UNAVAILABLE` and production NO-GO.

Windows file and parent ACL are obtained using native .NET `FileSystemAclExtensions.GetAccessControl` with the explicit native PowerShell Security cmdlet as a legacy fallback. Any missing verification provider remains `UNAVAILABLE` with unavailable evidence, not `Valid` or `no broad write`.

The audit independently checks parent directory low-trust create/delete/rename/WRITE_DAC permissions, not just EXE ACLs. Its acceptance fields explicitly remain:
- `signedReleaseManifestVerified=false`
- `processHighTokenVerified=false`
- `installedRunningImageIdentityVerified=false`
- `productionReady=false`

Matching SHA-256 beside the EXE is developer integrity, **not** proof of a signed and protected manifest or pinning a real Nexowire publisher.

## Windows token provider evidence only, not a Broker identity

`scripts/audit-windows-broker-token-provider.ps1` performs a **read-only Win32 inspection of the process running that script** using `OpenProcessToken(TOKEN_QUERY)` and `GetTokenInformation(TokenIntegrityLevel,TokenElevation)`. The native code never starts a service or high-token process, alters permissions, obtains `PROCESS_DUP_HANDLE`, or installs a Broker.

The output discloses the actual test-token integrity RID, elevation and Administrators-enabled status, or an explicit provider error. It never equates a token belonging to the **test PowerShell process** with a Nexowire Broker. Independently attested installed Broker PID, exact signed on-disk **and running** image, owner/device/CORE epoch, signed release/rollback manifest, protected full import tree, and protected process-handle duplication boundary are all `false`. `elevatedCoreDispatchEnabled=false` and `productionReady=false` are unconditional.

A high-integrity token detected on an unrelated hosted runner must not be misrepresented as a signed or enrolled Nexowire Broker.

## Bounded negative tests and exact CI

`test/windows-job-helper-acl-publisher.test.ts` covers forged caller PowerShell functions being ignored and a source-built unsigned helper remaining NO-GO.

`test/windows-broker-provider-attestation.test.ts` uses a **disposable copy** of a real Microsoft Authenticode-signed Windows EXE. After mutating its signed bytes and replacing its loose companion digest, Authenticode is rejected even though the new loose checksum matches. A disposable directory with an Authenticated Users Modify ACE is identified as parent-ACL replacement risk. A separate disposable PowerShell module hijack fixture fails to forge `Valid`. Native caller token evidence must be genuinely available. No installed file or running user process is touched.

The test suite runs in a dedicated GitHub-hosted Windows CI step. An unavailable real provider or failed negative assertion must yield a red CI, **not skipped/mocked success**.

## Dependencies

Production remains blocked by #617 elevated CORE/ROOT Broker authority and signed local enrollment; #323 actual Admin Bridge effective state; #271 inherited unsafe writable elevated ProgramData; #551 pinned Nexowire-signed installer, rollback manifest and protected parent import ACL; and #576 Job guardian same-user lowpriv `PROCESS_DUP_HANDLE` retention. #608 source CI is not a physical Broker approval.

**No elevated shell, UAC interaction, VM operation, installed Agent/Broker service mutation or user PID termination occurred.**
