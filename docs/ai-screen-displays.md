# AI Screen: monitor-aware capture (Windows)

## Discover displays without taking a screenshot

Call `windows_private_display_topology` first to discover available host
monitor IDs and their real pixel coordinates, dimensions, primary monitor,
effective DPI, and virtual union bounds. This tool:

- Works **without** starting `NexowirePrivate` or opening a GUI window.
- Does not render, transfer, or save a PNG; does not read any Default desktop
  window contents.
- Returns `topologyKind: "host_shared_native"` and
  `independentAiDisplays: false`. This is host display discovery only,
  not an isolated virtual-monitor provisioner.
- Returns `perMonitorDpiAwarenessApplied` and nullable effective DPI
  measurements; no assumption that 96 DPI means scaling is disabled.
- Validates stable IDs, contiguous indexes, exactly one primary, and
  consistency of the union bounds; validates unchanged Windows input desktop.

Example workflow:

1. `windows_private_display_topology` to obtain monitor IDs and bounds.
2. `windows_private_screen_capture` with **no source selector** to capture
   the entire private workspace on **all** connected host monitors.
3. If explicitly requested, call `windows_private_screen_capture` with
   `source:"monitor"` and `monitor_id` from step 1.
4. For requested *new independent* AI monitors, call
   `windows_private_display_plan`, which validates the intended topology
   but reports `applied:false` until a separately isolated display backend
   exists.

## Legacy physical GUI controls are blocked in private AI mode

When `NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop` or the private
enforcement policy applies, the Agent rejects **all** legacy Windows GUI
commands that would otherwise operate on the owner's `Default` desktop:

- `windows.window.list/focus` (use `windows.private_desktop.windows`
  and managed private-window tools)
- `windows.pointer.position/move/click/scroll` (use
  `windows.private_pointer.move/click/scroll`; reading the physical
  cursor position remains unavailable inside private AI mode)
- `windows.keyboard.type/hotkey` (use `windows.private_keyboard.*`)
- `windows.accessibility.tree/find/invoke/set_value` (there is no
  equivalent isolated native accessibility provider yet; use explicit
  private pointer/keyboard/window APIs, never silent Default fallback)
- `windows.clipboard.read/write/clear` (use the isolated Agent-memory
  `windows.private_clipboard.*` tools instead; no owner clipboard access)

These 15 routes return `AI_PHYSICAL_GUI_NOT_ISOLATED` **before** input
validation, host GUI access, or physical-console grant checks. A grant
to use the physical console does not override this AI isolation rule.
The separate `windows.screenshot` and physical WPF virtual pointer
protections remain in force with their existing specific error codes.

Without a configured private AI target, the legacy Windows GUI tools
retain their existing behavior. This rule is enforced centrally for
direct MCP calls and nested execution through task graphs or runbooks,
not just in client/UI prompts.

## Agent-memory private clipboard

For AI-only copy/paste, use the following tools. These do **not** interact
with the Windows clipboard or persist secrets to disk:

- `windows_private_clipboard_write`: store up to 20,000 text characters
  scoped to the current running `NexowirePrivate` desktop session
- `windows_private_clipboard_read`: return the stored text with a
  `max_chars` limit that **rejects** oversized reads without truncation
- `windows_private_clipboard_status`: whether private text exists, its
  length and update time, without returning text
- `windows_private_clipboard_paste`: send stored text to one explicitly
  selected and revalidated private HWND through the native private keyboard
  path; no `Ctrl+V`, physical focus change, or system clipboard access
- `windows_private_clipboard_clear`: explicitly wipe the in-process text
  buffer, even if the private desktop is no longer running

The buffer is cleared on Agent process restart, and becomes invalid if the
private desktop stops/restarts or its session ID changes. Private reads,
writes, and pastes require an active private desktop. The clipboard is text
only; there is no image/HTML clipboard transport and no automatic sync to
the physical Windows clipboard.

A successful private paste means native WM_CHAR delivery was requested to
a verified private HWND. Applications that do not support WM_CHAR, or
require a focused child control, may need a different private input path.
Never silently fall back to the physical clipboard.

## Host-shared clipboard shortcuts are forbidden on private windows

Even a message sent directly to a private HWND can cause that application to
read the Windows window-station clipboard. Therefore
`windows.private_keyboard.hotkey` now refuses `Ctrl+C`, `Ctrl+V`,
`Ctrl+X`, `Ctrl+Insert`, `Shift+Insert`, `Shift+Delete`,
Windows/Shell key combinations, and secure/system exit combinations.
It returns `PRIVATE_HOTKEY_HOST_SHARED_NOT_ISOLATED` **before** issuing
any native input. Common application-local hotkeys such as `Ctrl+A`,
`Ctrl+Z`, `Alt+F4`, and `Shift+Tab` remain available.

To paste text into a private window, use `windows.private_keyboard.type`
or the Agent-memory private clipboard tools when installed; neither relies
on Windows `Ctrl+V`. This protection does not make the host WinSta0
clipboard OS-isolated. Native clipboard read/write by arbitrary launched
applications remains an open limitation of desktop-object-only isolation
until a separate guest/window-station backend is available.

## Private mouse-wheel routing

`windows_private_pointer_scroll` scrolls an explicitly selected private
top-level window by posting `WM_MOUSEWHEEL` or `WM_MOUSEHWHEEL` only after
native `NexowirePrivate` desktop membership validation. Inputs are the
target `hwnd`, client coordinates `x`/`y`, a signed, nonzero multiple
of 120 as `delta` (up/down or left/right depending on `axis`), and
optional `axis:vertical|horizontal`. Input is capped at 10 wheel notches
per request. The implementation translates client to screen message
coordinates without changing the actual system cursor, foreground window,
or input desktop. A zero delta, malformed HWND, or point outside the
private window fails closed.

The helper posts to the selected private **top-level** HWND, not arbitrary
children or global cursor position. Applications that require wheel events
on a specific child control may not respond. The positive/negative wheel
direction and message payload were accepted by the actual WinForms DEV
fixture; this does not claim support for every GUI toolkit.

## Private scrolling without moving the physical pointer

`windows_private_pointer_scroll` sends one bounded `WM_MOUSEWHEEL`
(vertical) or `WM_MOUSEHWHEEL` (horizontal) message to an explicitly
selected top-level NexowirePrivate HWND. The Agent:

- Revalidates that the HWND belongs to `NexowirePrivate` immediately
  before posting, and checks client-relative `x,y` are in bounds
- Translates the private client point to the screen-coordinate `lParam`
  expected by Win32 wheel messages without moving the user's cursor
- Requires a signed, nonzero `delta` from -1200 to +1200 divisible by
  120; rejects malformed requests before sending any native input
- Reports `touchesSystemCursor:false` and the actual input desktop

This is posted-window-message scrolling, not hardware `SendInput` or
physical cursor movement. Some applications route wheel events to a
specific child HWND; a successful post does not guarantee that an
arbitrary application scrolled.

## Task Scheduler activation cannot escape into owner GUI

In private AI mode, `windows.task.control` rejects Task Scheduler
`action:start` and `action:enable` with
`AI_PRIVATE_SCHEDULED_TASK_GUI_NOT_ISOLATED`. These operations can
launch an existing interactive Windows task in the logged-in user's
session on `Default`, even if the command that triggered Task
Scheduler was hidden or attached to `NexowirePrivate`.

The guard is in the central Agent capability dispatcher, before a
physical-console grant or privileged Broker RPC. It cannot be bypassed
by FULL mode. `action:stop` and `action:disable` remain available for
emergency containment under normal permissions. Inventory and private
desktop launch APIs remain unchanged; ordinary non-private operation
retains its existing authorized Task Scheduler behavior.

This does not guarantee arbitrary tasks, services, native shell brokers
or COM launches are isolated: the broader process launch audit remains
open in issue #402.

## Known Windows shell-broker entry points are blocked on private launch

`windows.private_desktop.launch` uses
`CreateProcess(STARTUPINFO.lpDesktop=WinSta0\\NexowirePrivate)`
for directly launched processes. Some Windows shell brokers can hand
activation to existing Explorer/COM or user-interactive processes on
`Default`, bypassing the immediate child desktop.

The private launch path now refuses these known direct executable
entry points (case-insensitive, including absolute-path variants):
`explorer.exe`, `control.exe`, `rundll32.exe`, `dllhost.exe`,
`mshta.exe`, `wscript.exe`, `cscript.exe`, `msiexec.exe`,
`fodhelper.exe`, `computerdefaults.exe`, `eventvwr.exe`,
`sdclt.exe`, `slui.exe`, and `hh.exe`. Such a call fails with
`PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED` before creating the process.
Direct GUI executables, browsers, editors and ordinary PowerShell/CMD
continue to be eligible.

This is a **known-broker denylist**, not proof of universal process
isolation. A PowerShell script or third-party executable can still
invoke ShellExecute/COM, delegate to Explorer, or launch an elevated
child; those transitive launch paths need separate tracing and a
guest/session isolation boundary before issue #402 can close.

## Elevated installer GUI cannot fall back to the owner desktop

`windows.installer.apply` is fail-closed with
`AI_PRIVATE_INSTALLER_UI_NOT_ISOLATED` when the AI default is
`private_desktop`. This check runs before physical console approval or
privileged-Broker dispatch. An elevated installer launches via
`Start-Process -WindowStyle Hidden`, but that hides neither
shell-brokered child GUI windows nor UAC/Secure Desktop consent prompts
reliably. Explicit owner FULL/Broker permission is **not** an exception
to private AI workspace isolation.

`windows.installer.preflight` and `windows.installer.status` remain
available under their existing permission rules because they do not
launch an installer. Outside private AI mode, the pre-existing FULL
and Broker installer approval contract is unchanged. No UAC bypass,
WinSta0 desktop switch, physical GUI automation or production
deployment is implemented by this guard.

## Private terminal: explicit Windows shell/COM broker prevention

`runWindowsPrivateShell`, used by AI `shell.exec`, runbooks and
workspace checks routed to `private_desktop`, durable private
`process.start` workers, and the direct
`windows.private_desktop.launch` PowerShell/CMD argument path now reject known
shell/COM launch patterns **before** starting a private shell process:

- Direct invocation of known Explorer, MSI, UAC and COM broker executables
- Plain PowerShell `Start-Process`, `Invoke-Item`, `Invoke-Expression`,
  `-Verb RunAs`, `ShellExecute` and shell automation object patterns
- Plain CMD `start` and direct broker executable commands
- Opaque PowerShell `-EncodedCommand` strings, which cannot be inspected

Normal developer commands (e.g., `npm run build`, `node --test`,
`Get-Content`, `echo`) remain eligible. Blocked commands return
`AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED` prior to private shell worker startup or direct process creation. For `windows.private_desktop.launch`, no new managed process PID is recorded when rejected.
This control does **not** parse all PowerShell syntax and cannot inspect
assembled strings, invoked scripts, shell aliases or compiled descendant
processes; it is an explicit-broker defense, not proof of transitive
isolation. Such commands must be confined by a separately authorized
guest/session boundary to close #402.

## Observed private window process provenance (read-only)

`windows_private_desktop_window_audit` inventories top-level windows
visible on `NexowirePrivate` and classifies their process IDs as
currently managed app PIDs, the tracked private shell PID, or
**untracked** PIDs. It compares the window count and input desktop from
two adjacent snapshots. Untracked PIDs are bounded to 64 distinct IDs
and truncation is reported. The tool does not change the user input
desktop, Windows ACLs, running process privileges, or the host display.

Even when every observed HWND has a tracked owner,
`fullDescendantIsolationVerified:false`,
`physicalDesktopLeakageExcluded:false`, and
`hostClipboardIsolated:false` remain explicit. **A successful audit
is not proof that a launched child did not also create a window on
the owner's `Default` desktop.** The tool has no view into process
descendants, WMI/COM brokered windows, independent window stations or
VM boundaries. If the first status snapshot cannot provide a window
count, its completeness is uncertain and the report should not be used
as acceptance evidence.

This is a supplementary diagnosis for #402, not a substitute for a
separate guest display provider and actual user-interaction acceptance.

## Capture contract

`windows_private_screen_capture` renders only windows belonging to the `NexowirePrivate` Win32 desktop. It uses `PrintWindow` to compose a PNG; it **never uses a screenshot of the owner's Default desktop**. When the configured AI default target is `private_desktop`, the legacy `windows.screenshot` tool rejects physical/default desktop screenshots with `AI_PHYSICAL_SCREEN_CAPTURE_NOT_ISOLATED`. The AI should use `windows.private_screen.capture` instead; without a selector it captures all private-screen monitor regions. Legacy physical capture remains available only outside private AI default mode.

- **No selector:** `source: "desktop"` (also the default) renders **all connected host displays** in a single PNG. The union includes any negative X/Y coordinates for displays to the left or above the primary.
- **Readable all-monitor set:** `windows_private_screen_capture_set` returns **one image per connected host monitor** (1–8), ordered by monitor index and accompanied by the full monitor ID, bounds and effective DPI. Each PNG is scaled independently with defaults of 2560×1440 per monitor, instead of shrinking a giant union bitmap. The call has independent `max_bytes` per PNG and a bounded `max_total_bytes` across all PNGs; by default, total output is limited to 16 MiB. It fails as a whole on hotplug, missing frames, invalid geometry, input-desktop changes or an exceeded image budget. It never includes owner Default windows. The ordinary `windows_private_screen_capture` **default remains a single combined all-monitor image** for backward compatibility.
- **One display:** `source: "monitor", monitor_index: 0` or `source: "monitor", monitor_id: "\\\\.\\DISPLAY2"`. IDs come from the capture metadata. Index 0 is valid; use IDs if ordering may change.
- **One window:** `source: "window", hwnd: "0x..."` and the handle must belong to a top-level `NexowirePrivate` window. The local WPF Viewer now lists private windows with exact HWNDs. Select a private window and click **PREVIEW WINDOW** to show only its current content. The **ALL SCREENS** button restores the combined preview even if the selected window has since closed. These buttons never activate the HWND, move the user's physical cursor, or switch the input desktop. Invalid HWNDs never capture the owner's physical desktop. If a previously valid selected private window closes, the Viewer recognizes `WINDOW_NOT_PRIVATE_DESKTOP`, clears the stale selection, and retries once with the combined private-desktop capture. Likewise, a disconnected selected host monitor (`PRIVATE_MONITOR_NOT_FOUND`) restores all-screen preview. A visible `PREVIEW SCOPE` notice records the automatic recovery; rendering failures, capture timeouts and other errors remain explicit and do not silently become a healthy preview.
- **Close a managed private app:** In the WPF Viewer choose a window and click **CLOSE APP**. The local Yes/No confirmation writes a bounded HWND request. The Agent calls `windows.private_desktop.window.close` only for verified Nexowire-managed private windows and reports the result in the Viewer. The command posts `WM_CLOSE`; a window with unsaved work may remain open. No arbitrary process termination or Default-desktop input is performed.
- Invalid, absent, or conflicting selectors **fail closed**, except the explicit recovery of a previously selected window that later disappears.
- PNG output bounds `max_width` and `max_height` are **downscale limits**, not instructions to change Windows display resolution.
- PNG `max_bytes` is an enforced limit. Native desktop source bitmaps above 120 megapixels fail with an explicit error rather than allocating unbounded memory.
- An existing but empty NexowirePrivate desktop or monitor region returns a valid background-only PNG with `emptyCaptureArea: true` and `capturedWindows: 0`. This is not a screenshot of the owner's Default desktop. When visible private windows exist but all rendering attempts fail, the capture still fails explicitly. The Viewer reports `LIVE EMPTY AI SCREEN` for a fresh empty capture, separately from capture errors or stale frames.

### Returned metadata

`source`, `monitorCount`, `monitors[]`, `selectedMonitorIndex` (null for all/window), `captureBounds`, `topologyKind: "host_shared_native"`, `perMonitorDpiAwarenessApplied`, `sourceWidth`, `sourceHeight`, PNG dimensions, scaling, window counts, and before/after input desktop.

Each `monitors[]` entry includes `index`, Windows `id` (`\\.\\DISPLAY...`), `x`, `y`, `width`, `height`, `primary`, `effectiveDpiX`, and `effectiveDpiY`. DPI values are nullable if Windows cannot retrieve them. The DPI-awareness flag reports whether the helper successfully requested per-monitor awareness.

### Explicit Windows capture repetition acceptance

The opt-in DEV test `test/private-screen-repeated-capture-soak.test.ts`
starts its own NexowirePrivate WPF fixture and performs six consecutive
combined all-monitor captures, per-monitor PNG batches, and exact-HWND
private-window captures. It verifies stable host topology, valid capture
scopes, and an unchanged Windows input desktop, then removes the fixture.

In PowerShell on an authorized, idle DEV computer:

```powershell
$env:NEXOWIRE_RUN_AI_SCREEN_REPEAT_SOAK_LIVE='1'
node --test --import tsx test/private-screen-repeated-capture-soak.test.ts
Remove-Item Env:NEXOWIRE_RUN_AI_SCREEN_REPEAT_SOAK_LIVE
```

The test is skipped by default in CI to avoid racing physical GUI/input
acceptance tests. This short capture-only check **does not** claim
long-duration or concurrent owner focus/cursor acceptance; a physical
multi-monitor setup must be separately verified.

### Important isolation boundary

Win32 *desktop objects* are **not** display adapters or virtual monitors. They share Windows session display topology and DPI policies with the owner's desktop. Changing native monitor count, resolution, scaling, or arrangement would change the user's environment and is **not** a supported private AI operation.

The following requested independent AI settings remain **unimplemented** until there is an isolated, verified virtual-display backend (e.g. a signed Indirect Display Driver plus a session/container design that cannot modify the owner's visible arrangement):

1. AI-selectable virtual display count (including headless systems).
2. Independent per-display mode, resolution, refresh rate, and scale/DPI.
3. Display hotplug and stable IDs, virtual coordinate placement, cross-monitor window routing.
4. Screenshot of all independent AI screens by default; exact one-screen selection when requested.
5. Hotplug/mode-change rollback and visible-owner-foreground/cursor invariants.

Do not misrepresent image resampling or a split canvas as a real independent virtual monitor, and never use host `ChangeDisplaySettingsEx`/`SetDisplayConfig` to fulfill an AI-private display request.
