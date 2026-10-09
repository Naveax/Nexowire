# P0 Windows rollback-token privilege preflight

Tracking P0 #271. This is a **read-only, current-process-token privilege inventory**, not an ACL restore, an elevation request, or authorization to restart/replace the privileged Stack.

## Purpose

On 2026-10-09, two separate disposable work-pc ACL-restore experiments failed under a non-elevated Windows account. icacls.exe /save succeeded on a new temp fixture, but /restore failed with a privileges-not-assigned error; a Set-Acl attempt also failed with missing SeSecurityPrivilege. Both used only temporary non-production files and cleaned up.

This script examines the actual Windows current process token using Win32 OpenProcessToken with TOKEN_QUERY (0x0008), GetTokenInformation(TokenPrivileges) and LookupPrivilegeValueW. It never asks for or enables any privilege (AdjustTokenPrivileges is never used).

## Run under the actual intended maintenance identity

    powershell.exe -NoProfile -NonInteractive -File .\scripts\audit-windows-restore-token.ps1

PowerShell 7 also works. The script has no accepted parameters or production path inputs.

The report distinguishes **present** and **enabled** for SeBackupPrivilege, SeRestorePrivilege, SeSecurityPrivilege and SeTakeOwnershipPrivilege. It also reports enabled Administrator membership and LocalSystem status. No account name, SID, secret, certificate or task argument is returned.

Missing privileges help explain why a recovery command may fail. Having them does NOT prove that an ACL/task/secret backup can be restored safely. Specific security descriptors, policies and tokens still matter. The output unconditionally reports privilegedRestoreAttempted=false, isolatedAclRestoreVerified=false, productionTaskRestoreVerified=false, protectedSecretsRestored=false, safeToRestoreProduction=false and safeToCutover=false.

## Verified work-pc result (2026-10-09)

The actual non-elevated work-pc token held none of the four queried privileges, as independently measured through Windows PowerShell 5.1 and PowerShell 7. This is consistent with the earlier restore failures, but does not prove their sole cause.

This preflight did not create files, adjust token privileges, query protected service credentials, manipulate task definitions, or modify the Naveax Stack. Regression tests exercise both PowerShell editions, the token state consistency, unexpected parameters and the isolated CurrentUser DPAPI/Task Scheduler restore fixture.

## Still required

Owner-approved elevated recovery context, independently authenticated protected task and DPAPI/OAuth backup, updater-safe protected runtime installation and ACL migration, **successful isolated privileged rollback** and real denied-write verification by the ordinary user token against the final code/import tree.

P0 #271 remains OPEN. Hub #265 and Broker #260 cutovers remain blocked. This preflight is diagnostic evidence only.
