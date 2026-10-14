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
  selected and revalidated private HWND, optionally to a same-process child
  control chosen using both `x`/`y` private client coordinates through the
  native private keyboard path; no `Ctrl+V`, physical focus change, or
  system clipboard access
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

## Private child-control mouse clicks

`windows_private_pointer_click` now validates the selected top-level
`NexowirePrivate` HWND and relative client `x,y`, hit-tests the
deepest visible and enabled child HWND **belonging to the same process**,
then converts the point to that child's client coordinate system.
`WM_MOUSEMOVE` and the requested left/right/middle mouse down/up
sequence are posted only to this target, without moving the system
cursor or foreground window. An invalid parent HWND or out-of-bounds
point fails closed; an embedded cross-process child is never targeted.

The real Windows DEV WinForms panel fixture accepted exactly one
`WM_LBUTTONDOWN` and one `WM_LBUTTONUP`. This is window-message
delivery, not universal GUI click support: WPF, browser-rendered
elements and controls requiring physical focus may need different
private APIs. No fallback to the physical input desktop is allowed.

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

The helper validates the selected **top-level** HWND on
`NexowirePrivate`, then hit-tests child HWNDs beneath the requested
client coordinates. Wheel messages are posted to the deepest visible,
enabled child belonging to **the same application process**. It never
changes the global cursor or foreground window, and will not post into
another process's embedded child. WinForms may forward an event it receives
from a child to the parent; this is normal message propagation, not
a second wheel request.

The positive/negative wheel direction and message payload were accepted
by the actual WinForms DEV fixture, including direct child control
delivery. Controls without native HWNDs and frameworks that require
focus-dependent scrolling may still need separate handling. This is not
proof of equivalent behavior in every GUI toolkit.

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

## Child text-box input inside a private app

`windows_private_keyboard_type` now optionally accepts **both**
`x` and `y` coordinates in client pixels relative to the selected,
validated `NexowirePrivate` top-level `hwnd`. Without coordinates
it preserves the previous top-level `WM_CHAR` behavior.

With both coordinates, the native helper checks the point lies within
the private top-level client area, descends only into visible, enabled
child HWNDs **owned by the same application PID**, then posts Unicode
`WM_CHAR` to that control. Supplying only one coordinate or an
out-of-bounds point fails closed. The Windows owner cursor, actual
keyboard focus and input desktop are unchanged. A real DEV WinForms
TextBox accepted this targeted text without a focus switch.

This is direct window-message delivery, not a universal text editing
or accessibility abstraction. WPF controls without their own child
HWND, browser-rendered text boxes, elevated apps and frameworks
requiring focus/IME composition may need different private-specific
input paths; no fallback to physical keyboard input is permitted.

## Read-only native child control inventory

`windows_private_desktop_controls` takes an explicit top-level
`NexowirePrivate` HWND and returns a bounded, read-only inventory of
its child Win32 controls: handle, class name, process ID,
visible/enabled flags and rectangle **relative to the top-level
client origin**. It can be used to choose coordinates for private
click, wheel and text controls rather than guessing pixel locations.

Enumeration runs on `NexowirePrivate` itself. The top-level HWND is
revalidated against that desktop; embedded child HWNDs belonging to
a different process are **omitted**. The scan is capped at 128 returned
controls and 512 inspected windows; `truncated` indicates incomplete
coverage, with a separate count of skipped foreign-process children.

No child window text, password field contents, owner `Default`
desktop data, physical focus changes or system clipboard access are
involved. Native HWND controls do not cover all WPF composition or
browser DOM elements; this is not a full UI Automation implementation
or an independent OS desktop guarantee.

## Exact private child HWND text targeting

After `windows_private_desktop_controls` returns a Win32 child
`hwnd` and its `className`, `windows_private_keyboard_type` may
receive them as paired `control_hwnd` and `expected_class` fields,
alongside the validated top-level `hwnd`. The target must still be a
visible and enabled descendant of that exact private top-level window,
belong to the **same PID** and match the expected case-sensitive
Win32 class name. It is checked again before every Unicode `WM_CHAR`
message. Invalid, stale, cross-parent, disabled, hidden or mismatched
targets are rejected without routing to the physical desktop.

This mode is mutually exclusive with client coordinate `x/y`
targeting, and neither existing top-level typing nor coordinate
typing changes behavior. A DEV WinForms fixture with two native
TextBox HWNDs confirmed that only the explicitly selected second
control received the text; malformed and mismatched targets failed
closed. Exact HWNDs can still be reused if an app destroys and
recreates the same control with identical class/PID: this is a safer
provenance check, **not** a permanent identity proof or full UIA
support.

## Exact child control targeting for the private memory clipboard

The same paired `control_hwnd` and `expected_class` fields can now
be passed to `windows_private_clipboard_paste`. The Agent sends its
ephemeral in-memory clipboard text through the validated exact-child
native `WM_CHAR` path, with same-PID, parent/child relationship,
visibility, enabled state and Win32 class rechecked before each char.
This mode is mutually exclusive with client `x/y` targeting. Missing,
stale, cross-parent or mismatched controls are rejected.

Neither the Windows clipboard nor `Ctrl+V`, `SendInput`, physical
cursor, keyboard focus, or `Default` desktop is used. The stored
private text remains scoped to the running private desktop. This does
not extend native HWND handling to browser DOM or WPF composition
controls without their own Win32 child handle.

## Exact child HWND click with point/identity agreement

`windows_private_pointer_click` may specify the pair
`control_hwnd` and `expected_class` from
`windows_private_desktop_controls`. The top-level private window
`hwnd` and `x/y` client pixels remain mandatory. Before each click,
the native helper verifies that the selected child is a **visible,
enabled, same-PID descendant** of the private top-level window,
matches its exact Win32 class name, and is currently the deepest
eligible child under that point. Invalid, stale or cross-parent HWNDs,
class mismatches and point mismatches fail closed before that click.
Normal coordinate-only click behavior is preserved.

The helper posts only the requested private Win32 mouse messages; it
does not touch the physical mouse cursor or switch input desktops.
This does not prove full GUI isolation or support controls without
native child HWNDs. UIA/DOM-level hit testing remains outside scope.

## Bounded private-window UI Automation control view

`windows_private_desktop_accessibility` is a read-only MCP and Agent
capability for a selected **verified NexowirePrivate top-level HWND**.
A temporary helper running on that same private desktop calls Windows
UI Automation `AutomationElement.FromHandle` and traverses
`ControlViewWalker`, bounded to 128 returned nodes, 256 visited
children and depth 5. Children belonging to any PID other than the
top-level window's native owner are excluded. The result contains
control type, class, automation ID, depth, enabled/offscreen flags
and client-relative bounding rectangles when available.

The action label is returned only for recognized non-password action
controls (buttons, radio buttons, checkboxes, menus, tabs and links).
It does **not** request TextPattern, ValuePattern or any Edit,
Text, Document or password control contents. It never enumerates
`AutomationElement.RootElement`, invokes/sets a control, switches
the input desktop or changes the physical mouse/keyboard.

The WPF DEV acceptance fixture verified that the private Button and
TextBox appear as semantic UIA controls with stable Automation IDs,
while the TextBox's secret text is absent and the user's
`Default` desktop remains active. This is **read-only** UIA:
`accessibilityCoverageComplete:false` is deliberately reported
because legacy/custom providers, inaccessible nodes and brokered
children may be omitted. It is not an assurance of independent
Windows session, virtual displays or transitive GUI isolation.

## Read-only private UIA semantic target resolution

`windows_private_desktop_accessibility_resolve` accepts one verified
private top-level `hwnd`, `automation_id`, `control_type` and an
optional exact `expected_class`. It performs a **fresh** bounded
private-window UIA ControlView inspection, refuses skipped, truncated
or cross-process inventories, and returns the client-relative
rectangle only when **exactly one** enabled, onscreen same-PID
control matches. A missing, duplicate, unavailable, or mismatched
control fails closed.

`uniqueInObservedSnapshot:true` means uniqueness **only within this
live bounded snapshot**, not a stable object identity or a complete
UI Automation tree. The result deliberately includes
`authorizesInput:false` and
`fullAccessibilityTreeVerified:false`. The selector does not
invoke buttons, set values, read text, move physical input,
change the host clipboard or cross to the owner's `Default` UI.

The WPF DEV acceptance fixture verified unique resolution of a
private button by Automation ID and rejection of a missing ID.
A subsequent UIA action backend will need its own authorization,
in-process identity revalidation and isolation acceptance; this
read-only selector grants none of those privileges.
## Read-only observed private process ancestry audit

`windows_private_desktop_process_audit` compares tracked
`NexowirePrivate` shell and managed launch PIDs with a bounded
`Win32_Process` CIM snapshot (up to 4096 processes) to report
observed direct and transitive parent/child links. It reports up to
128 descendant PIDs, suspected PID reuse, missing tracked roots,
cross-session descendants, and inventory truncation. The native
Windows process table is queried read-only; process names,
executables, command lines and user-profile paths are **not
collected or returned**.

A live Windows DEV acceptance test verified that a Node process
launched on the private desktop could spawn another Node process,
which appeared in the ancestry report without switching the
user's `Default` input desktop.

Parent PID data is inherently non-authoritative once parents exit,
PIDs may be reused, and inaccessible processes might be omitted.
The report permanently marks
`ancestryComplete:false`,
`independentSessionVerified:false`,
`physicalDesktopLeakageExcluded:false` and
`noUntrackedChildrenProven:false`. An empty descendant list is
never evidence of complete sandbox isolation. This audit does
not modify Windows services, permissions, task scheduler,
process lifetimes or session configuration.

## Explicit private WPF Button invocation through UI Automation

`windows_private_desktop_accessibility_invoke_button` is a
**mutating** capability, separate from the read-only UIA inspection
and target-resolution tools. The caller must supply a validated
NexowirePrivate top-level `hwnd`, a specific `automation_id`,
and an exact `expected_class`. A helper launched on the **same
private desktop** enumerates at most 256 ControlView descendants,
rejects incomplete or cross-PID results, requires exactly one
matching `ControlType.Button`, and rechecks that it is enabled,
onscreen, not a password element, and still owned by the same PID
immediately before requesting `InvokePattern.Invoke()`.

The native helper does **not** use the physical cursor,
`SendInput`, foreground-window changes, Windows clipboard,
global UI Automation `RootElement`, or a shell/UI broker.
A real Windows DEV WPF fixture verified an app-local Button click
callback and unchanged `Default` input desktop; incorrect HWND,
automation ID, class or a TextBox target was rejected.

This invokes app-owned code and **can cause application-side
effects**. It is not a general UAC/broker permission, independent
OS session guarantee, full UIA action framework, or proof that
an app cannot itself spawn GUI onto the user's `Default` desktop.
The existing descendant/desktop isolation acceptance in #402
remains mandatory before claiming production-safe arbitrary GUI
automation.

## Explicit private WPF Edit ValuePattern text entry

`windows_private_desktop_accessibility_set_edit_value` is an
explicit **mutating** MCP action, not part of read-only UIA. It
requires the exact verified private top-level `hwnd`, nonempty
`automation_id`, exact `expected_class`, and the caller's new
text (`value`, at most 4000 characters). A helper launched on
`NexowirePrivate` scans a bounded ControlView subtree and
requires exactly one **same-process**, enabled, onscreen,
non-password `ControlType.Edit` matching those fields.
Incomplete, ambiguous, wrong-class and inaccessible control
trees fail closed. Only `ValuePattern.SetValue` is called;
`Current.Value` and other existing text contents are **never read**.

A real Windows DEV WPF TextBox fixture accepted the new text,
while the owner input desktop remained `Default`; a separate
PasswordBox was rejected. No `SendInput`, foreground focus,
global keyboard or system clipboard is used. The value does pass
through an ephemeral helper request file that is deleted when the
request completes; callers should not treat that temporary file
as a secret-storage boundary.

UIA providers can have application-side effects, and a malicious
application can still broker windows or activities elsewhere.
This does **not** establish transitive confinement or replace
independent OS sessions/VM-based isolation.

## Idempotent private WPF CheckBox state

`windows_private_desktop_accessibility_set_checkbox` is an explicitly
**mutating** MCP action for a unique private WPF/UIA CheckBox selected by
validated top-level `hwnd`, `automation_id` and exact
`expected_class`. The caller supplies a desired boolean
`checked`. The private helper traverses a bounded same-process
ControlView subtree, rejects incomplete/foreign or ambiguous trees,
and requires an enabled, onscreen non-password
`ControlType.CheckBox` with `TogglePattern`.

The helper reads only the checkbox's `ToggleState`. If it already
matches the requested state it performs **no toggle**. Otherwise
it calls `Toggle()` once and checks the resulting state; it never
blindly retries a side-effectful toggle. The `Indeterminate` state,
disabled controls, duplicated Automation IDs, wrong classes and
other control types fail closed.

Real Windows DEV WPF acceptance tested an Off-to-On transition,
idempotent repeated On request and On-to-Off transition, including
negative disabled, mixed, duplicate and foreign-target cases.
Input remains attached to `NexowirePrivate`; neither the physical
cursor nor the physical keyboard nor Windows clipboard is used.
Application-defined callback side effects and indirect GUI
brokering are **not** contained by this capability, so guest/session
isolation remains an unsatisfied #402 acceptance condition.

## Explicit private WPF RadioButton selection

`windows_private_desktop_accessibility_select_radio` is an explicitly
**mutating** MCP capability for a single RadioButton within a
verified `NexowirePrivate` window. The caller supplies top-level
`hwnd`, `automation_id` and exact `expected_class`. A private
helper performs a bounded same-process UI Automation ControlView
scan, rejects incomplete, foreign, missing or ambiguous targets,
and confirms the element is an enabled, onscreen,
non-password `ControlType.RadioButton` supporting
`SelectionItemPattern`.

The action reads only `SelectionItemPattern.Current.IsSelected`.
It calls `Select()` once only when that radio option is not
already selected, then validates the postcondition. This prevents
an unnecessary second selection event but does not suppress
application-defined side effects. It never reads textbox/password
values, moves the physical cursor, changes host keyboard focus or
touches the system clipboard.

Windows DEV tests covered selecting the second radio, repeating
the same choice without another event and returning to the first.
Wrong HWND, class, missing ID, disabled control, duplicate
Automation IDs and wrong control types fail closed.
This is not complete session, descendant-process or physical
desktop isolation; #402 remains open.

## Mixed private UIA vs. owner-input regression

`test/private-uia-mixed-owner-isolation.test.ts` is a Windows DEV
acceptance test for consecutive private WPF GUI operations. It
creates a temporary private window with a Button, Edit, CheckBox
and two RadioButtons, and exercises all four UIA action types in
three successive cycles. The test verifies the app-side callback
and output of each operation, and checks that the input desktop
remains `Default` between cycles.

In addition to API result flags, a **read-only** Win32 observer
samples `GetCursorPos` and `GetForegroundWindow` before and
after private actions. It fails if the DEV physical cursor or
owner foreground HWND has changed. The observer never moves a
cursor, sets focus or switches desktops. Because unrelated DEV
user input would also cause a failure, the test should run on
an unattended DEV/CI Windows session. The live three-cycle
run passed.

This is a bounded acceptance test, **not** proof of all
intermediate events, transitive child-process confinement or
an isolated virtual monitor/session. These remain distinct
#402 release requirements.

## Observed private-process GUI ownership on Default

`windows_private_desktop_owner_gui_audit` is a bounded read-only
diagnostic. It takes the tracked private shell and managed process
roots, then follows only the **observed** Win32 parent PID links from
`windows_private_desktop_process_audit`. A separate helper opens
the `Default` desktop of the calling process's window station using
`OpenDesktop` for **enumeration only**, and uses
`EnumDesktopWindows`/`GetWindowThreadProcessId` to count
top-level HWNDs owned by those candidate PIDs. The native helper
never requests window titles, captions, text values, classes,
coordinates, foreground focus, user input, or clipboard contents.
Unrelated window owner PIDs are filtered before returning data.

The result includes `observedDefaultWindowOwnerPids` and
`observedDefaultWindowCount`. A **positive** match is a useful
warning that a tracked process has a top-level window on the
enumerated Default desktop. An empty result does **not** prove
absence of a leak: process parents can exit, PIDs can be reused,
windows may appear between samples, and `OpenDesktop` may
refer to a session/window station other than the owner's active
one. The API deliberately reports
`ownerWindowStationVerified:false`,
`allIntermediateEventsObserved:false`,
`noDefaultGuiProven:false` and
`physicalDesktopLeakageExcluded:false`, even when no
matching HWND is observed.

DEV acceptance verified this inventory runs without switching
the current input desktop; synthetic tests verify that a leaked
PID is reported and unrelated PIDs are never returned. The
scanner fails with an explicit error if the read-only Default
desktop cannot be opened or enumerated; it never falls back
to interacting with the user's desktop. This is a diagnostic,
**not** transitive process containment or owner-session
isolation.

## Explicit PowerShell -File broker preflight

`NexowirePrivate` direct launches and short-lived private shell
workers perform an additional bounded static preflight for a
literal `powershell.exe/pwsh.exe -File script.ps1` (or abbreviated
`-F`, `-Fi`, `-Fil`) invocation. PowerShell `-Command` abbreviated options
are checked using the same broker denylist; opaque encoded commands,
unsupported `-CommandWithArgs` and inline command/file option values
fail closed. The checked file must be a readable, regular,
non-symlink local script no larger than 256 KiB. Its UTF-8
or BOM-marked UTF-16LE text is passed through the existing
high-confidence GUI/elevation broker command denylist before
a private process is started. Unreadable or oversized scripts
fail closed. The process manager also calls the same
preflight when preparing its private durable worker.

The Windows DEV acceptance verified that a script containing
`Start-Process explorer.exe` was refused before launch
while a harmless PowerShell `-File` script completed on
`NexowirePrivate` without switching `Default`.
Both paths have dedicated negative/positive tests.

This is a **bounded static text check**, not a PowerShell parser,
signature policy, content integrity guarantee or process sandbox.
It cannot prove safety against script replacement between
inspection and execution, dynamically constructed commands,
nested imports, compiled executables or indirect
`ShellExecute`/COM/UAC dispatch. Scripts that cannot be
safely inspected must be rejected, not silently run on
the owner's desktop. Transitive confinement remains open in #402.

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
