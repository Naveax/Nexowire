# QA19: independent #709 Windows Job and protected importer acceptance

Date: 2026-10-22. DRAFT, test/docs/workflow ONLY. Production NO-GO.

## Immutable baseline

- #700 owner initial 637ff3a6e8705e94e6ffba91790fd83329beee3f: CI https://github.com/Naveax/Nexowire/actions/runs/39645643225, Windows browser-live job 119380363262 FAILURE; original Windows Job suite 35 PASS / 0 FAIL / 0 SKIP, new protected-tree stage 17 PASS / 3 FAIL / 0 SKIP.
- #717 QA19 81f705faf24c55bf1af38a9b7a0b0bb101a84e97: dedicated hosted https://github.com/Naveax/Nexowire/actions/runs/39659333504 SUCCESS (3 forensic/provider + 2 Job), inherited full CI 39659333082 FAILURE with original three tests still red.
- #709 owner b083004b9ab8c18125a428cf74f3e97f7adf4e88: owner CI https://github.com/Naveax/Nexowire/actions/runs/39658979397 SUCCESS across seven jobs. Independent QA19 exact-base check is separate.

## Root cause and what is not established

Windows NODE TEMP fixture spelling is C:\Users\RUNNER~1\AppData\Local\Temp\... while actual PowerShell inspected file names use C:\Users\runneradmin\AppData\Local\Temp\... . Test fixture lowercased literal comparisons are NOT valid final on-disk identity checks for 8.3 aliasing. #717 independently recorded 3 inspected files, 1 import, 13 physical file/ancestor records, real native ACL evidence, and matching GetAccessRules detection of injected disposable Authenticated Users Modify on imported directory. Literal -File input and splatted PowerShell argument transport both counted the same paths. No actual missing imported file or ACL provider was witnessed. A broad write ACE was ALSO observed for C:\ drive root on the hosted runner: no complete protected production tree was proven.

#709 owner changes request transport to strict v1 base64 UTF-8 JSON envelope and updates the ORIGINAL previously failing protected-tree security tests to compare realpathSync.native physical identity. Their meaningful security assertions remain: importer/updater/ancestor ACL must exist, low-trust parent Modify is dangerous, out-of-root updater is rejected, missing DLL cannot become clean or trusted. Do not revert those negatives or mask a failure.

## Independent #19 delivery

Only new test files, new QA-specific workflow and this evidence document. No changes to the #03 PowerShell importer/provider source, native helper, owner tests, CI security steps or runtime Broker.

1. Exact byte-identical #679/#717 100-cycle stdout/stderr-before-exit and PID/guardian/FILETIME anti-spoof fixture from blob e5db891e5d04ad71770deaa0a4a9f2a744c2a64a.
2. Independent Windows identity and TEMP ACL test checks all three images and ancestor paths by actual realpathSync.native and statSync dev/ino. It prints 8.3 short name vs full name and verifies native file identity, not string matching.
3. Independent .NET FileSystemAclExtensions / GetAccessRules observes only a uniquely created TEMP Authenticated Users inheritable Modify grant, demands fail-closed audited low-trust parent result; outside updater, missing import and malformed envelope remain negatives.
4. Real OS Microsoft-signed copy must be Valid under intact native PowerShell Security provider. An audit COPY with a deliberately invalid native module manifest lookup must return UNAVAILABLE, publisherValid false and productionReady false even when companion SHA matches; OS modules are never modified.
5. Dedicated hosted Windows workflow runs the byte-identical 100-cycle fixture, new QA19 negatives, and UNMODIFIED source owner tests: core-broker-protected-tree, core-broker-process-witness, windows-job-helper-acl-publisher, windows-broker-provider-attestation. No skip, continue-on-error or manual rerun.

## Hard production gates

Synthetic source tests do not attest a Nexowire-signed installed Broker, signed manifest/import graph, protected EXE/ancestor/updater tree, authenticated owner/device epoch, installed HIGH token and process file identity, PROCESS_DUP_HANDLE low-trust isolation, external durable CAS or independently verified mutation postcondition. CORE elevated dispatch and production acceptance remain disabled. Lost ACK is UNKNOWN, never auto replay. No local live Agent, service, UAC, VM, OS ACL or ReVoltVPN-Ubuntu-Lab actions. #03 owns implementation; #00 decides eventual integration.
