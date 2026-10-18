# P0 #402: Windows private desktop indirect-wrapper and native picker acceptance

Stacked branch: `fix/ai-screen-wrapper-escape-native-picker-20261018`
Base: DRAFT PR #556 (`af8d267d6bbe6f69fdb6cf668258b98e3d6f4f10`), itself preserving original #480 shared broker-deny helper as commit `c116d59`. #480 remains an independent unmerged DRAFT and should be deduplicated at integration. No main merge, live Agent/Broker deployment or user desktop automation.

## Confirmed RED and mitigation

At the original #556 HEAD, `cmd.exe /C wsl.exe --list --quiet` was **not rejected by static preflight** and reached `windows.private_desktop.launch` in an isolated WinSta0\\NexowirePrivate test; this does not mean WSLg or the owner desktop was isolated. No WSLg/Windows Terminal GUI was deliberately opened.

The new static check rejects known WSL, wslhost, Windows Terminal, bash and sh references even in quoted/chained CMD or PowerShell commands. The **direct private desktop launcher** no longer accepts CMD, PowerShell `-Command`, all direct Node/Python/Java/dotnet/Git runtime wrappers and common package-manager entrypoints, or script/shortcut executable aliases. Unlike a static regex-only denylist, this denies those opaque interpreter modes even for benign command text; the private desktop is a GUI boundary, not a general shell-execution environment. The **private shell worker** retains existing bounded ordinary build/inspection commands, but now rejects explicit literal WSL/Terminal bridge references. The direct private launcher also rejects WindowsTerminal.exe and wslconfig.exe aliases. Keep error codes distinct: `AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED` for broker in shell worker; `PRIVATE_DESKTOP_OPAQUE_WRAPPER_UNISOLATED` for direct opaque launch; `PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED` for direct broker binary.

## Physical, read-only Windows acceptance

Tests run in a new temporary private desktop using a temporary WinForms process. The **modern native OpenFileDialog** (`AutoUpgradeEnabled=true`) is opened only in the isolated process. Query private top-level HWND, process PID and session ID; check the same PID does not appear in the physical Default window enumeration and private HWND is not the physical foreground HWND. Read-only UIA inventory tests real edit/button semantic types; an explicitly untrusted control ID **must not** mint an operation token. Negative owner PID, Windows session, desktop start instance and emergency stop must fail closed. Never call native `ValuePattern.SetValue` or `InvokePattern` against the real Common Item Dialog.

Prior #556 evidence: independent temporary WPF positive case, WinForms Pane negative, file picker path allowlist, 25 passing isolated unit/live tests. This addition is a read-only modern Common Item Dialog ownership test, **not** positive native Common Item Dialog file selection or general Explorer/COM descendant isolation.

## Unresolved production blockers

- `PowerShell -File` uses a bounded static script preflight for WPF/WinForms fixture tests. Scripts can invoke dynamic/native code; static preflight is **not** a security sandbox, is susceptible to file changes before execution, and must not be described as complete transitive containment. Same for compiled applications, JS/Python scripts, indirect COM/ShellExecute or Windows elevation/UAC paths. Robust production acceptance requires OS-level Job Object/child provenance plus separate Windows logon session/VM boundaries and fail-closed owner desktop monitoring.
- Real Explorer/COM cross-process dialogs remain **unsupported** by the mutation adapter; owner PID/session/window must match the approved private process, and WinForms controls identified merely as Pane are untrusted. No fallback to generic physical `windows.accessibility.invoke/set_value`. Any cross-PID/unknown control must stop without guessing.
- Private foreground focus transitions during SetValue/Invoke are not atomically attested by the current UIA helper. Untrusted focus change, window recycling, user UAC secure desktop, process/grant cancellation and unknown mutation must not trigger blind replay; additional native thread-input focus telemetry, generation-bound capabilities and user-active long soak are pending.
- Genuine second physical monitor, Win+S/Start stress, high DPI, multi-app COM and physical Agent release/update acceptance are pending. No claims of production PASS.

Validation:
`node --test --test-concurrency=1 --import tsx test/private-gui-wrapper-escape.test.ts test/private-desktop-shell-broker-gate.test.ts test/private-shell-broker-guard.test.ts test/private-file-picker-guard.test.ts test/private-file-picker-path-policy.test.ts test/private-file-picker-live.test.ts test/private-file-picker-winforms-live.test.ts`
plus opt-in `NEXOWIRE_PRIVATE_COMMON_DIALOG_LIVE=1 node --test --import tsx test/private-common-dialog-readonly-live.test.ts`.
