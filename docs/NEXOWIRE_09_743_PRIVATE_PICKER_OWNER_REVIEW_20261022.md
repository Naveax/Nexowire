# NEXOWIRE #09 | #736 with #743 forensic integration review | 2026-10-22

**Owner scope:** AI Screen `windows-private-file-picker.ts`, `windows-private-desktop.ts`, `private-desktop-runtime-owner-gate.ts`, matching tests and Windows CI. No #03 protected Broker/provider/Job source overwritten. DRAFT and **PRODUCTION NO-GO**.

## Exact upstream witness and API compatibility

- #736 source HEAD `c68c561dae9a19b5bae5136675c6418f7ae235a6`, run #39677383239: **seven SUCCESS**. Pre-approved signed CORE Guardian reservation remains a distinct authority and is unmodified.
- #743 head `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`: main CI #39678489196 SUCCESS, QA17 #39678489203 SUCCESS, independent QA03 Windows #39678489269 SUCCESS. The actual #743 patch is a protected-tree audit PowerShell dual-interface fix, QA source/tests and dedicated hosted workflows. It **does not implement** the private desktop OS process launch, terminate, child tracking or protected lifecycle witness API requested by #09.
- Older #03 `verifyWindowsKernelJob(pid,creationFiletime,guardianPid,guardianJobHandle)` queries the real OS with `IsProcessInJob` and `GetProcessTimes`, but the caller must *already* have an authentic protected owner/guardian Job HANDLE, launch-to-parent provenance and signed native process tree. A caller-supplied PID/handle/boolean cannot attest itself. Do not connect this read-only probe directly to user-writable `state.json` and assume trust.
- #743 expressly leaves `transitiveImportsIndependentlyEnumerated=false`, `nativeEffectiveLowPrivilegeAccessCheckCompleted=false`, `signedImportManifestVerified=false`, `protectedCompleteImageTreeAttested=false`, `processDupHandleBoundaryVerified=false`, and CORE executor dispatch disabled. Source green ≠ physical elevated signed Broker.

## Narrow own source correction

The production singleton `createPrivateFilePickerAdapter()` previously minted an UIA grant on `status.launchedPids` / HWND / PID / session snapshots without its **own protected Job owner witness**. Such snapshots are derived from untrusted/private helper state. The real singleton now first checks the persisted emergency-stop marker and invokes `requireProtectedPrivateDesktopOwner('picker')`. The gate maps to read-only private-UIA action, requiring the same independently protected double-read owner/JOB/creationTime contract before granting UIA or dispatching edit/confirmation. No authenticated provider is wired, so **production prepare currently fails closed**. Caller-injected `dispatch` remains an explicit synthetic test fixture and is not physical OS proof. No new authority is exposed through remote request fields.

The real picker checks the owner both during `preflight` and again before each edit/invoke phase. This narrows stale-window, cancellation and COM-descendant races but **is not kernel-atomic**; a protected provider must keep an immutable HANDLE/Job/owner lease across actual native mutation.

## Bounded tests and negatives

- `test/private-picker-native-owner-failclosed.test.ts`: real production picker prepare denies untrusted PID/Job before querying any GUI; actual emergency marker denies before the native owner read; test adapter with same HWND but changed COM child PID rejects before edit and forbids replay; signed CORE task evidence cannot be substituted for a private picker owner; CMD/PowerShell DLL/COM/Wsl/RunAs broker attempts remain denied. Zero physical desktop clicks, UAC or VM.
- Re-ran target suite on Work PC: **78/78 PASS, 0 skip, 0 fail**, with prior picker policy, source owner fence, CORE/Broker test. Typecheck, build, launch audit PASS, 59 direct child_process sinks / 45 tracked signatures; unchanged caveat on indirect native/COM/ShellExecute/renamed binary descendants.
- New Windows CI step runs the test on exact branch HEAD. Do not use #736 or #743 CI green for the new SHA.

## Remaining #03 provider contract (BLOCKED)

#03 must deliver a **protected** runtime private desktop owner with: native Job and retained non-inheriting process handles, PID+creation FILETIME bound to exact signed image/ACL/owner epoch, parent-child creation/desktop/session provenance, immutable cancel/stop lease and no foreign PID kill, and independently authenticated native postcondition receipts including UNKNOWN. It must be enabled only after signer/import/updater/parent ACL and effective rights are physically attested. A plain read-only OS check returned after process creation does not ensure atomic ownership.

AI Screen `killTree(pid)` still contains PID-only taskkill in dormant stop path; #736 source gates prevent it from being called without an authenticated collector. The stop marker only prevents **new** GUI actions. It does not terminate processes, rollback native effects, prevent all interleavings or prove private desktop physical acceptance. Do not deploy merged until #03 delivers OS-mediated owner lifecycle and separate signed CORE trusted Broker release gates.

Other BLOCKED: genuine Explorer/COM cross-process file accepted by application, real UAC Secure Desktop (never automated), owner-active foreground/second monitor soak, dynamic child process breakaway. Old #480 overlap already in main; no blind merge.
