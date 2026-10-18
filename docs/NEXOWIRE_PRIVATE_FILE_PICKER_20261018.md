# P0 #402: Private Windows UI Automation file-picker adapter

Branch: `fix/parallel-09-ai-screen-uia-filepicker-20261018`. Work PC source-only staging; no production install, registry/UAC changes, or main merge.

## Threat model and deliberately narrow boundary

A physical `Default` desktop, `WinSta0\\NexowirePrivate`, the Windows secure desktop used by UAC, a Win+Tab virtual desktop, and a physical second monitor are different surfaces. We **never** switch the input desktop or issue `SendInput` for the file picker. The owner's changing foreground HWND on `Default` is expected while background AI works: it must not be captured, focused, or treated as the private picker. We instead reject a private *target* HWND when it disappears, changes owner, or changes session.

The generic `windows.accessibility.find/invoke/set_value` operate in the owner's Windows UI Automation context. `invoke/set_value` already require an explicitly approved, time-bounded physical console grant. They must **not** be reused silently for an AI-isolated file picker. The new adapter uses the existing native private-desktop **read-only UIA inventory**, private `ValuePattern.SetValue`, and private `InvokePattern` helpers, which revalidate top-level desktop membership, unique same-process controls, HWND/PID/Windows session and input-desktop state in the helper process. This is intentionally stricter than attempting to cross from UIA into Explorer/COM.

## API

1. Start the private desktop with `windows_private_desktop_start`, **without** calling `show`. Launch a directly attached GUI through `windows_private_desktop_launch`. Inspect `windows_private_desktop_status`, `windows_private_desktop_windows`, and `windows_private_desktop_accessibility`; obtain the exact current `hwnd`, `processId`, `sessionId`, `startedAt`, `automationId`, `className`, and `controlType`.
2. Call `windows_private_desktop_file_picker_prepare` with exact target HWND/PID/session/start timestamp, a unique same-PID visible `ControlType.Edit` filename control, and a unique visible `ControlType.Button` confirmation control. This creates an in-memory, one-use, 60-second **operation binding token**. It is **not** owner approval or additional authorization. Authorization still belongs to the authenticated account/device policy layer. Preparation is categorized as **mutating**, because it creates the token.
3. Call `windows_private_desktop_file_picker_select` with this `grant_id` and an absolute local Win32 path (no UNC/device paths). It rechecks both controls, invokes the private edit ValuePattern, reinspects identity/desktop and both controls, then invokes the private button. It does not expose the supplied plaintext path in its return value; SHA-256 is returned. The result is `submitted=true`, `selectionVerified=false`. Independently verify the owning app accepted/opened the file.
4. Call `windows_private_desktop_file_picker_cancel` with grant ID to revoke pending steps; it cannot reverse an already-running native Invoke. The existing `windows_private_desktop_stop` remains a coarse emergency stop. Stop/restart invalidates the desktop session bound to a grant.

Failure codes include `PICKER_DESKTOP_UNSAFE`, `PICKER_PROCESS_UNTRACKED`, `PICKER_WINDOW_CHANGED`, `PICKER_IDENTITY_CHANGED`, `PICKER_INVENTORY_INCOMPLETE`, `PICKER_CONTROL_UNAVAILABLE`, `PICKER_CONTROL_NOT_UNIQUE`, `PICKER_GRANT_INVALID`, `PICKER_CANCELLED`, `PICKER_PARTIAL_EDIT`, `PICKER_EDIT_STATE_UNKNOWN`, and `PICKER_MUTATION_STATE_UNKNOWN`. On unknown mutation outcomes **do not retry** until UI/application state is independently reconciled.

## Work PC evidence

- New synthetic negative cases: missing/recycled window; untracked/wrong PID; changed Windows session; secure desktop; incomplete/foreign-process inventory; hidden/disabled/ambiguous control; expired/reused/cancelled grant; invalid UNC/device/relative paths; target-owner change between edit and confirmation; helper timeout; emergency stop; and cancellation during a pending edit. All operate on mocked Windows UIA, with zero physical input.
- Live Windows WPF fixture is created on a new temp `NexowirePrivate` desktop. It accepts a synthetic filename path through the private Edit/Invoke patterns and records a marker. Before/after `inputDesktop=Default` and native `sessionId` is asserted. Test cleans up only its own fixture/root. This is **not** proof of support for Explorer-brokered Common Item Dialogs.
- `node --test --import tsx test/private-file-picker-guard.test.ts test/private-file-picker-live.test.ts`
- `npm run typecheck`, `npm run build`, `npm run ai-screen:launch-audit`, `npm run continuation:check`

## Explicitly open acceptance gates

1. Arbitrary COM/ShellExecute/UAC/elevation descendants may still escape immediate CreateProcess desktop containment. Known bridge executable deny rules from PR #480 are included but not a guarantee of arbitrary descendant containment.
2. Native Explorer/COM shell-backed file pickers and dialogs owned by a *different* PID intentionally fail closed; support requires a privileged, separately reviewed architecture or a real isolated Windows user session/VM.
3. Real second-monitor/virtual-display viewer, DPI/per-monitor multi-app performance, sustained user-active keyboard/Win+S/Start Menu regression and stuck-worker force-stop E2E have **not** been signed off. The private desktop is not an OS virtual monitor.
4. `InvokePattern` can trigger arbitrary app-side side effects (including dialogs elsewhere). It is only invoked for the verified private process; app-level file acceptance needs independent postconditions.
5. Scoped operation grant IDs live in one Agent process; reconnect/restart invalidates them. This is not a durable owner authorization grant or multi-account principal proof; those checks must remain enforced by the Hub/Agent authentication stack.
6. Existing generic physical `windows.accessibility.invoke/set_value` console-control behavior is not broadened. A separate review is needed before allowing any automatic physical-foreground automation.

Keep DRAFT; keep #402 open and do not deploy to the owner's active desktop.
