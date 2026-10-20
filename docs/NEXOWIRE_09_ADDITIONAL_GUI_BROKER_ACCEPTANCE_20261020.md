# P0 #402, team #09: newly verified Windows GUI broker omissions

## Proven source defect and mitigation

At `origin/main=fda2a2da164ea7c6a2fe2271fc669f1fd623cede` the central private GUI broker deny set omitted:
- `regsvr32.exe`: indirect DLL/COM code execution outside the original private GUI process and unproven descendant desktop identity
- `runas.exe`: alternate logon GUI process creation; owner/session boundary not attested
- `schtasks.exe /run`: execute a task on a previously configured user/session desktop
- `forfiles.exe /C`: arbitrary nested command launch

The existing private PowerShell command-string gate also omitted generic `New-Object -ComObject <ProgID>` and `[type]::GetTypeFromProgID(...)` activation and explicit `Invoke-CimMethod/Invoke-WmiMethod Win32_Process Create` patterns. Old `#570` paths are preserved; this change extends only one existing centralized guard. The negative test first ran RED: direct `regsvr32.exe` was admitted, not rejected. No risky Windows executables were started to establish the RED state.

## Code / tests

- Add high-confidence broker executable names to `src/agent/windows-private-shell-broker-guard.ts`. Extensionless names and full paths are handled by the same policy. The cmd/powershell string preflight denies these names, COM activation and explicit WMI/CIM Create patterns. It is intentionally conservative and does **not** prove arbitrary dynamic aliases, renamed executables or recursive launch chains are isolated.
- New `test/private-desktop-additional-brokers.test.ts` checks direct executable and CMD/PowerShell wrappers without running them. The isolated native Windows test creates only `WinSta0\\NexowirePrivate` in a temp directory; verifies all new launch requests reject before `request('launch')`, no new private application PIDs, and input desktop stays `Default`. Physical Default HWND is only queried through the existing read-only `windows.window.list`; its value is not modified and is not assumed stable if the user acts concurrently.
- Add the test as a distinct step to Windows `browser-live` GitHub Actions job; no test skips and no existing tests removed.
- New broker preflight + existing Windows shell regression: 19/19 PASS, 0 skips on Work PC. Typecheck and AI Screen direct process audit PASS; 59 direct child_process callsites/45 signatures unchanged.
- Existing #579 helper SHA-256 and browser cleanup and merged #590 native UIA/HWND/PID/session/grant/Common Item Dialog regressions remain in current main and will be tested again.

## Overlap / boundaries

Old #480 OPEN/DRAFT reports `mergeable=false`, but `git cherry -v origin/main origin/fix/ai-screen-direct-bridge-broker-guard-20261014` gave `- f9c37df006c1b068b63b79983e4f2129f6a8dce4`: its patch is equivalent to an already-main broker fix from #570. Do **not** merge/rebase the old #480 branch blindly. PRs #579 and #590 are already MERGED; this is a new independent team #09 patch.

**#03 Job coordination needed:** current private desktop `killTree(pid)` uses PID-only `taskkill.exe /PID ... /T /F` on stored launched PIDs, and ignores some termination errors, not a verified immutable Windows Job membership or native process HANDLE. #09 will not edit the shared Job owner implementation, stop live Agent processes, or test malicious PID reuse on a user's session. #03 must supply kernel Job/handle-identity and independent native process provenance acceptance; until then broader descendant containment and production acceptance are **BLOCKED**.

Known other BLOCKED: Explorer/COM cross-PID file selector file-acceptance postcondition, native helper Authenticode publisher/trusted ACL immutable file identity and script TOCTOU, arbitrary CMD/PowerShell/WSL/Windows Terminal native child escapes, real UAC secure desktop in isolated VM, active-user foreground/input soak, physical second display. File-picker must stay local path/authorized policy; #08 streaming requires separate chunk-based file transfer, never copy file bytes to clipboard/one browser input. No live service UI changes or main merge.

## CMD call/@call second RED/green finding

During exact-head hardening, the literal command `cmd.exe /C call regsvr32.exe /s fake.dll` was **admitted** by the original anchored host-executable matcher; the new negative fixture reported RED without executing any broker. The matcher now explicitly recognizes `call` and `@call` before a quoted/full-path executable, and additional negative cases cover `call "C:\\Windows\\System32\\schtasks.exe"` and `@call explorer.exe`. Fresh broker + private desktop physical tests: **19/19 PASS, 0 skipped** and typecheck PASS. This remains a high-confidence static preflight, not proof of arbitrary dynamic child containment.
