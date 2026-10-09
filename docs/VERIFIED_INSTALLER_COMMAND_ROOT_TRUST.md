# P0 verified Windows installer executable and protected-root trust

Tracking P0 #271 and installer bootstrap #269. These changes harden the machine-approved elevated Broker installer job *source*. They do not install or execute software in production.

## Threat and change

Previously an elevated approval check launched powershell.exe via inherited caller PATH and PSModulePath; owner/ACL hardening launched icacls.exe by relative name, while the detached elevated installer runner also resolved PowerShell via PATH. An attacker able to influence the caller environment could substitute one of those executables. In addition, process.env.ProgramData could redirect machine approval and verified job roots to a user-chosen disk location.

The updated code:

- Requires the canonical local C:\ProgramData root and fixes job staging at C:\ProgramData\Nexowire\verified-installers. Other drives, user folders, UNC/device paths, traversal, and altered ProgramData fail closed.
- Reads machine approval only from C:\ProgramData\Nexowire\installer-approvals.json under the same strict root preflight, preserving the existing explicit Administrator/SYSTEM-only ACL owner verification and exact SHA256/arguments/publisher policy checks.
- Pins both Windows icacls operations to C:\Windows\System32\icacls.exe. Pins the approval ACL check and detached elevated installer child to C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe.
- Gives the Windows child processes an allowlisted system-only environment, System32 working directory, shell:false, and bounded timeout/response for synchronous calls. The approval verifier imports the Windows system Microsoft.PowerShell.Security module via an exact path, ignoring caller-supplied modules.
- Maintains existing full versioned payload hash recheck, Authenticode/publisher policy and machine-approved exact argument vector. It does not bypass UAC, duplicate elevated privileges, or change owner-approved policy.

## Verification

15/15 Windows work-pc focused tests passed. Existing benign .cmd installer runner smoke test and altered SHA negative test were executed in disposable folders, with fixed inbox PowerShell and trusted module paths; the fake package did not touch an actual protected installer staging area. TypeScript typecheck/build/diff passed. New tests reject spoofed user ProgramData and assert pinned executables, child environment and exact module imports.

## Remaining blockers

The protected root still needs independently verified parent ACL, reparse/TOCTOU resistance, updater-safe complete code/dependency protection and actual denied low-privilege writes. Shell pinning is not an independent Nexowire JS publisher signature. High-integrity task and real DPAPI/OAuth rollback remain unverified; live legacy Highest Stack still has Authenticated Users: Modify. P0 #271 must stay OPEN. No live install, scheduled task mutation, Hub/Broker restart, protected credential access or deployment occurred.
