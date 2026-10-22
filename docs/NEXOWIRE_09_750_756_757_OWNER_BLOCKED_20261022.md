# NEXOWIRE #09 | #750 CI failure and #756/#757 native/Access handoff
Date: 2026-10-22. Own AI Screen QA-only branch, no installed Agent or user GUI/VM/UAC.

## STEP 1: Exact hosted failure, not inherited Windows Job

Source parent **#750 HEAD `90e4819dcebaba3d2a07231f65386b306f0e7637`**, GitHub Actions **CI #39735615243 overall FAILURE**:
- `browser-live` Windows **SUCCESS**, including synthetic Windows Job and new `private-picker-native-owner-failclosed.test.ts`.
- Linux-native, macOS lifecycle, security-operational, WSL2 **SUCCESS**.
- **Node24 `test (24)` FAILURE**: `npm run check` > `npm test`, exactly **1** own new test failed: `production picker refuses forged tracked PID before querying any real UIA` at `test/private-picker-native-owner-failclosed.test.ts:33`. Linux correctly rejected the Windows-only native picker first with `PrivateDesktopError.code === 'WINDOWS_REQUIRED'`, while the test incorrectly expected `PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE`. Full npm test produced 2,142 cases, 1 failure. **Node22 cancelled**, not independently failed. This is NOT the inherited Windows Job fast-exit error.
- Fix is strictly in owned #09 test: Windows requires `PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE`; non-Windows requires the genuine earlier `WINDOWS_REQUIRED`. No runtime guard weakened or assertion removed. Independently call the platform-neutral `requireProtectedPrivateDesktopOwner` for **picker, launch and stop**, and require no collector -> `PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE` everywhere.
- GitHub hosted CI on the new commit is **mandatory**; earlier Windows/source successes cannot substitute.

## STEP 2: #756 Native owner and #757 Access (exact heads)

- **#756** `d4ed32f72701e5157929cbb9d36bdf0a90fc0d57`: main CI **#39736305461 SUCCESS**; dedicated native Windows QA **#39736305459 SUCCESS**. Its real Win32 `CreateFileW` access probes and `OpenProcess` + `GetProcessTimes` + `QueryFullProcessImageName` + `PROCESS_DUP_HANDLE` rights probes run ONLY on **marked disposable TEMP-owned synthetic fixtures**. Receipt fields explicitly remain `installedBrokerProcessAttested=false`, `protectedJobHandleInheritanceAndDaclVerified=false`, `separateLowPrivilegeCallerBoundaryVerified=false`, `fullTransitiveImportInventoryVerified=false`, `productionReady=false`. No installed signed HIGH Nexowire Broker and no protected private-desktop lifecycle owner provider.
- **#757** `93acbb7a4e830485ce94015b3c76837a3fcdad34`: main CI **#39736445337 SUCCESS**. Source-only signed late-permit/CAS readback and CORE/ROOT dispatch review; all green returns `CURRENT_SOURCE_ONLY_NO_EXECUTION` with `elevatedExecutionAllowed:false`. The final-native-effect race, external CAS atomicity, genuine installed signed Broker/owner epoch and high token remain blocked. Signed CORE Access permit != OS Job HANDLE ownership and cannot authorize private GUI/UAC.
- **#743** native inherited ACL/import QA is also source/fixture evidence, not protected AI Screen launch+stop provider. Source-only `verifyWindowsKernelJob` checks real membership only after a protected Job HANDLE exists; it cannot mint one by reading a PID in `state.json`.

## STEP 3: AI Screen current acceptance and fail-close

The actual runtime #728/#736/#750 source already applies:
- `requireProtectedPrivateDesktopOwner` BEFORE start/child launch/stop and before native picker UIA grant/edit/invoke, with no default native collector and no RPC-provided override
- emergency-stop fence recorded before local viewer status; fails closed on corrupted state and denies new GUI, keyboard, pointer, child launch and picker operations
- foreign HWND/COM child PID, wrong session, expired/revoked grant and UNKNOWN side effects never cause click, editable Default focus, or blind replay
- pre-approved signed CORE Guardian/Broker policy remains separately authorized; no repeated per-command UAC automation or generalized GUI elevation

**Production NO-GO:** No signed installed protected private-desktop lifecycle owner implementation currently binds host+shell+children to the same retained kernel Job HANDLE, PID+creation FILETIME, independently observed parent image/desktop/session, owner/reconnect/revoke epoch and protected atomic kill-on-close. `killTree(pid)` still contains PID-only taskkill, safely unreachable from the default blocked stop path, not proven safe. The writable stop marker alone cannot kill an existing child, cancel an in-flight native action or prevent malicious local modification. No complete protected signed EXE/import/update chain, physical owner UAC permission, or cross-PID Explorer file acceptance has been proven.

## STEP 4: Precise interface request, NO cross-owner source edits

Only #03/#756 Native Owner may implement a protected API with immutable signed root Job ownership (noninheriting retained kernel handles), native PID + FILETIME after actual CreateProcess and Job attach, parent-child chain, same private desktop/session and hash/publisher/ACL, separate user-token rights, and atomic safe cancel/close effects. All operations must return an independently authenticated immutable receipt; uncertain launch/stop side effect -> UNKNOWN and no replay; never generic taskkill against a stale PID.

Only #04/#757 Access may provide owner epoch/generation + signed current permit and deny revocation/late permit before native dispatch. This never replaces the native Job receipt or authorizes Secure Desktop automation.

#09 will integrate only after these two independent owner/provider contracts are physically implemented and tested with actual signed protected Broker, and must not invent optional production `protectedRead` callback from request JSON/environment. No #03/#04 files changed, no live Agent, GUI, mouse/keyboard, VM, UAC, service, main merge or physical user-process terminate.

## Local proof
Bounded Work PC Windows suite: **78/78 PASS (zero skips)**, typecheck/build/AI Screen launch audit PASS; 59 direct child_process sinks and 45 tracked signatures unchanged. This proves **only source acceptance**.
