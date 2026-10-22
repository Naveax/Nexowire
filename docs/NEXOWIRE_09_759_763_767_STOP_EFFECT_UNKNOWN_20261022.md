# NEXOWIRE #09 | #759, #763 and #767 cross-review / emergency STOP physical-effect negative
Date: 2026-10-22. DRAFT, #09-owned source/test/docs only; never run live GUI, UAC, Agent, VM or user's process/input.

## Exact HEAD upstream evidence

- #759 HEAD `28f6a1cf063e05e70d09739a2b2d8f12e896c67d` GitHub run **#39802773499**: all seven hosted jobs individually **SUCCESS** (Node22/24, browser-live Windows, Linux native, macOS lifecycle, security and WSL2). Its earlier ongoing workflow status was stale. No Windows Job failure at this HEAD.
- #763 HEAD `e67f8f4ce14adb161a81f1f1ab45becbf5d7f40c`: dedicated native strict JSON QA **#39803137184 SUCCESS**; full CI **#39803136306 IN_PROGRESS** at last exact check. This owner patch closes PowerShell ConvertFrom-Json v1 type coercion (numeric literal 1 accepted; string "1", boolean true, float, malformed imported-module types and extra fields rejected), maintaining read-only protected ACL tests. It is NOT a high-token signed executor launch or AI Screen Job-owner service; `CORE_EXECUTOR_DISPATCH_ENABLED=false` and productionReady=false. No #03 files modified here.
- #767 HEAD `6967cc92ae85e5d1034591940d273615c4056e00`: exact CI **#39803417079 IN_PROGRESS** at last check. Access owner source requires Ed25519 signed installed protected Broker candidate with fresh nonce and independent signed FINAL CAS grant, but even all green returns `FINAL_SOURCE_CANDIDATE_ONLY`, `dispatchEffective:false`, `canLaunch:false`, `canReplay:false`. It does not atomically serialize the native effect with revoke or supply a protected Job HANDLE. No #04 files modified here.

## Genuine #09 production source gap (RED before fix)

`src/agent/windows-private-desktop.ts:stop()` persisted emergency-stop marker and read `state.json`, then returned `data:{running:false,stopped:false}` if the file was missing. **No native process HANDLE, Job closure, FILETIME or immutable termination receipt was consulted.** A missing user-writable state file does not imply the Windows host, COM child, UIA helper or orphaned GUI process physically exited. Thus source could misreport the OS side effect.

New independent Windows test in `test/private-desktop-runtime-owner-failclosed.test.ts`: disposable TEMP worktree with deleted `state.json`, no real spawned processes. First and repeat `windows.private_desktop.stop` must reject with exact `PRIVATE_DESKTOP_STOP_UNVERIFIED`, persist `emergency-stop.pending`, and deny subsequent launch. **Before source change**, test was reproducibly **RED**: `AssertionError: Missing expected rejection`; other existing regressions PASS. No production GUI action was performed.

**Fix:** Preserve recording emergency cancellation before parsing state. When no state exists, throw `PRIVATE_DESKTOP_STOP_UNVERIFIED` with explicit lack of native Job-owner termination proof; never return fabricated `running:false`/stopped result. Existing corrupted JSON rejects separately; existing stale PID records still fail before raw taskkill because protected kernel provider is missing. No signed CORE Broker policy change and no new launch/kill helper.

## Source validation and unresolved owner boundaries

- Work PC scoped **69/69 PASS, 0 SKIP**, exact target files, test-before-code RED reproduction documented, TypeScript typecheck, build and AI Screen launch audit PASS. Audit still 59 direct child_process sink callsites/45 signatures and cannot attest indirect COM/ShellExecute.
- **#09 runtime remains default fail-closed** for private desktop launch, child input worker, real picker grant and actual stop because #03 has not installed an authenticated native owner/Job/HANDLE+PID creation FILETIME provider. NO production GO.
- `status()` remains a non-authoritative visibility observation, not an OS Job stop receipt; do not equate a missing `state.json` with a verified physical exit in UI or operator reports. Only authenticated OS termination readback, coupled with owner epoch/CAS, can upgrade UNKNOWN.
- #763 strict JSON input type alone does not grant CORE authority; #767 signed final Access grant alone does not prove Windows process ownership or atomic effect. #756 Native owner probes are limited to TEMP test fixtures. #03 and #04 independently own native Job and Access/CAS source, respectively; no generic UAC consent automation or blind `taskkill /PID` may be substituted. Real installed signed publisher/import closure, effective lowpriv ACL, real OWNER CAS and COM/picker file acceptance remain BLOCKED.

No live Agent/GUI/VM/UAC/keyboard/mouse/desktop/process mutation, no main merge, no owner files overwritten. New exact HEAD hosted CI must complete independently.
