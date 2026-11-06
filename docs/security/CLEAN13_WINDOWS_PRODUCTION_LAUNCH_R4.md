# CLEAN-13 / V2-01 Round 4: Windows production launch architecture decision

Date: 2026-11-05. Repository: Naveax/Nexowire. Source owner: PR #1077.
Status: ARCHITECTURE DECIDED, IMPLEMENTATION NOT ACCEPTED, WINDOWS LAUNCH NO-GO.

## Decision and exact claim

Do not promote native/windows-cloudflared-image-probe.c into an executable custodian, package it, sign it as a production launcher, or resume the process created by the probe. The probe is unsigned, disposable-test-only and always terminates its CREATE_SUSPENDED process. Existing src/mcp/cloudflare-binary-trust.ts must continue to reject Windows production execution at the native signed handle custodian boundary, even when official SHA256 and Authenticode are valid.

Recommended CONDITIONAL target for managed Windows installations:
1. A separately reviewed, hardened, signed launcher running in a dedicated service identity, installed only through a privileged, owner-authorized lifecycle.
2. Windows App Control for Business with user-mode code integrity (UMCI) enabled in an enforced, tamper-protected policy, independently reviewed rules for the executable and launcher, and demonstrated kernel deny events on actual negative launches.
3. Per-release, SYSTEM/service-owned protected NTFS staging, with exclusive publishing, exact flat-file SHA256 pin, handle-bound native WinVerifyTrust, full parent/reparse/alternate-stream/link and owner DACL checks. A normal user process must not be able to mutate the published executable.
4. While holding a source handle with no write/delete sharing and held directory handles, CreateProcessW with absolute lpApplicationName and CREATE_SUSPENDED; verify FileIdInfo for process-path reopening, MEM_IMAGE name and process creation identity. Assign process to a kill-on-close Job Object before any resume; release locks only after confirmed process admission and durable lifecycle ownership.
5. Treat these checks as complementary. They do NOT provide a documented CreateProcessW input section handle. A real attestation of the loaded image under WDAC policy, adversarial process execution tests, signer/policy authenticity and operational recovery is still mandatory before enabling the launcher.

This architecture is not implemented. There is no signed launcher, trusted policy signer, WDAC rollout authority, security attestation, recovery approval or live process execution acceptance in #1077. The production Windows entry point remains fail-closed.

## Supported API findings and limitations

| Mechanism | Supported and useful | Boundary that remains |
|---|---|---|
| CreateFileW held source, FILE_SHARE_READ only | Blocks ordinary concurrent write/delete and rename opens under Win32 sharing semantics; works with native SHA256 and FileIdInfo | Privileged tampering, previously created writable mappings, filesystem filter behavior and kernel compromises need independent assessment |
| GetFileInformationByHandleEx(FileIdInfo) | 128-bit file identity with volume serial across two open handles | An image pathname reopened in user mode is not the process image-section object handle |
| WINTRUST_FILE_INFO.hFile and WinVerifyTrust | Documented native Authenticode verification of an already-open file handle | WinTrust trust status is not process section identity. The pinned Cloudflare release flat SHA256 remains required; independent publisher/chain/revocation rule validation remains required |
| CREATE_SUSPENDED | Prevents primary thread execution until ResumeThread | Does not bind the original hFile to CreateProcessW; secondary injection, DLL loading and other risks still need a trusted launcher |
| QueryFullProcessImageNameW | Process image path readback | Path does not constitute image section or immutable bytes attestation |
| VirtualQueryEx + GetMappedFileNameW | Actual MEM_IMAGE mapped-file name readback | Returns mapped name, not a kernel section HANDLE to compare with validated hFile |
| Win32 documented SEC_IMAGE mapping | Can create an image mapping view | CreateProcessW offers no documented hSection parameter for execution; do not adopt undocumented NtCreateProcessEx or NtCreateUserProcess internals as a production contract |
| App Control / WDAC enforced UMCI | OS code-integrity policy can block unauthorized user-mode executable code during image validation | Device-wide policy deployment has major compatibility and recovery cost; audit mode, policy inventory alone or generic allow rules do not prove Cloudflared enforcement |
| Signed, immutable launcher and protected staging | Limits same-user tampering and process identity races when combined with WDAC | Without WDAC and a separate administrative writer identity, an admin or file-owner attacker can undermine ordinary path and DACL controls |

API evidence:
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
- https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_file_info
- https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust
- https://learn.microsoft.com/en-us/windows/desktop/api/psapi/nf-psapi-getmappedfilenamew
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/appcontrol-wizard-create-base-policy

## Candidate comparison and operational cost

| Candidate | Security value | Rollout cost / risk | Decision |
|---|---|---|---|
| Existing disposable native probe as launcher | Confirms signed source, identity, and lock behavior | Unsigned, unshipped and missing actual image-section proof | FORBIDDEN |
| Path + SHA256 + CREATE_SUSPENDED + MEM_IMAGE readback only | Better than unchecked spawn, catches common pathname substitutions | TOCTOU and unauthorized code execution cannot be excluded for all attacker classes | NO-GO |
| Separate signed launcher, owner/service-only protected staging, WinTrust held handle | Good file-custody defense with supported Win32 APIs | Dedicated service, updates, signing and multi-SID negative testing; not enough against machine administrator/kernel by itself | DEFENSE-IN-DEPTH ONLY |
| Enforced signed WDAC/UMCI policy + signed launcher + protected staging | OS-enforced code trust and user-mode block gate, with independent pinned release identity | High: device-wide policy compatibility, signing PKI, Secure Boot/HVCI review, updates, administration, reboot/rollback recovery, potential boot/app compatibility impact | RECOMMENDED MANAGED-DEVICE TARGET, NOT YET GO |
| Unsupported native Nt* image-section process construction | May appear to accept section objects under undocumented interfaces | Unstable ABI, update compatibility, dangerous security assumptions, no supported design contract | REJECT |

Important Windows policy details:
- Enable user-mode code integrity (rule option 0). Merely observing one or more enforced policies is NOT proof that user-mode Cloudflared is constrained by the intended signer and image rules.
- Do not use broad filepath, issuer-only, AllowAll or managed-installer trust as the sole Cloudflared approval. Review base plus every supplemental policy and cross-policy allow logic. Prefer narrow approved signer and release pin; test that a Microsoft-signed but non-Cloudflare EXE is rejected in the protected launch scenario.
- App Control hash rules use Authenticode/PE image hashing, NOT necessarily the flat SHA256 of the downloaded release; both require independent, correct evidence.
- Start policy deployment only on disposable VMs in audit mode, analyze CodeIntegrity events (3076 audit, 3077 enforced, 3089 signature context), then enforce in staged rings. A single audit log is not an enforced block.
- Signed policy updates and removal can lock out boot or apps. Before any real deployment require policy-signing key custody, recovery media, recovery plan, version management and independent rollback tests. No automatic WDAC policy install is permitted here.
- Security preconditions include verifying protected service account, file and parent SID/DACL rights, owner and foreign user negative scenarios, installed launcher signer and hash, and immutable version manifest. Production configuration must not let untrusted users select an arbitrary executable path or switch to a soft-fail trust mode.

WDAC evidence:
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/deployment/enforce-appcontrol-policies
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/deployment/use-signed-policies-to-protect-appcontrol-against-tampering
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/citool-commands
- https://learn.microsoft.com/en-us/windows/security/threat-protection/windows-defender-application-control/select-types-of-rules-to-create

## Real source and Windows CI evidence

Round 3 remains intact: native MSVC probe, held-source flat SHA256 and FileIdInfo, CREATE_SUSPENDED, reopened process path, MEM_IMAGE NT name, real separate-process same-owner write/delete/rename and ancestor mutations, symlink/junction/hardlink negatives. The child is killed without ResumeThread.

Round 4 adds:
- scripts/audit-clean13-windows-launch-readiness.ps1: READ-ONLY actual Windows CiTool inventory and separate fixed-binary PowerShell 7 / Windows PowerShell 5.1 signer checks. Its schema always emits productionLaunchGO=false and nativeHeldImageSectionCustodianImplemented=false; it cannot verify WDAC policy scope or authorize launch.
- .github/workflows/ci.yml: requires that inspector report official source SHA+signature valid and production launch NO-GO. Hosted CI is not allowed to install a WDAC policy or modify production devices.
- native/windows-cloudflared-image-probe.c: documented WINTRUST_FILE_INFO.hFile held-source signature check, combined with native SHA and FileIdInfo before any suspended-process operation. Uses cache-only revocation retrieval and fails closed on missing trust.
- Windows native test and MSVC build: require held_winverifytrust marker and link Wintrust library. Same-owner mutation and P1-A/B/D negatives remain mandatory.

Exact historical hosted CI evidence:
- SHA 7330b96dd8675fb2feb9d9af60d4a57186eef4d5, run 42022382191, Windows browser-live job 127228525017: inspector emitted SHA pinned=true, direct Authenticode valid=true, PowerShell 7 SIGNED_SOURCE_VALID at about 1.0s, PowerShell 5.1 NONZERO_FAIL_CLOSED exit 29 after ~2.5s, and CiTool activeEnforcedPolicyCount=3. PolicyScopeProven=false and actualBlockEventProven=false. The number 3 is OBSERVATION, not proof of the required rules or UMCI. Existing P1-B and P1-D and native probe PASS, inherited V2-04 task stop FAIL.
- SHA 4249afaed7e0f681577f9ff99e9e08da08f0492d, CI 42022990192: inspector showed PS7 SIGNED_SOURCE_VALID, PS5.1 NONZERO_FAIL_CLOSED exit 29, WinTrust held-handle P1-A native test PASS on disposable Windows; owner/ACE and source signature PASS; Windows task-stop FAIL is V2-04 scope. See exact job logs for final run IDs and exit codes.

PS5.1 is NOT accepted as a reliable positive signer engine on these runners; failure must deny, not fall back to path-only execution. PS7 valid results do not authorize the unsigned native probe to become a launcher.

## Mandatory acceptance checklist for a future production implementation

1. Independently signed and reviewed launcher, authentic signed WDAC/UMCI base and supplemental policies, correct signer/file rules, policy version and revocation/rollback controls.
2. Disposable Windows VM: verify actual policy enforcement by attempting unauthorized unsigned, self-signed, wrong publisher, wrong version, substituted image, malicious injected DLL/child, revoked signature and prior valid-but-revoked signer. Capture CodeIntegrity 3077 and correlated 3089 where applicable; assert negative executable was not resumed.
3. Independent SID/accounts: owner-only source positive; foreign owner/ACE, inherited ACE, parent rename/junction, hardlink/symlink, file ID and pre-existing writable section/mapping race negatives. Never claim current same-owner CreateFile attempts cover all writable-mapping vectors.
4. Held-handle native signer verification plus OS-enforced process image policy allow/block evidence. Compare file IDs and MEM_IMAGE readback while suspended and before Job Object assignment + resume. Parent/descendant lifecycle owned by V2-04 must pass separately.
5. Controlled installer/upgrade, reboot, rollback, signed-policy recovery, long-lived process supervision, off-network remote admission and owner/device revocation on nonproduction test infrastructure. Do not conflate a Windows binary trust check with P1-C public URL acceptance in #1085.
6. Repeat all original #1044 P1-A/B/D negatives without skip or altered assertion. The three source blobs must remain byte-identical. Linux descriptor-bound checks and same-UID follow-up remain independent.

## Final release authority

P1-A Windows executable image: NO-GO (direct kernel section binding unproven; WDAC scoped enforcement NOT_RUN).
P1-B Windows official source: CONDITIONAL PASS (flat SHA + PowerShell 7 Authenticode + native held-handle WinVerifyTrust on disposable runner; execution provenance still unproven).
P1-D Windows owner/ACL: CONDITIONAL DISPOSABLE PASS (no live credential/production operation).
P1-A Linux: CONDITIONAL PASS for fd-bound path swap; same-UID writable-alias sealing unproven.
Overall Windows production tunnel and Connection v2 release: NO-GO. Keep the Windows startup denial, PR Draft, and main unchanged.
