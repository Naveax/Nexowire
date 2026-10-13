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

## Capture contract

`windows_private_screen_capture` renders only windows belonging to the `NexowirePrivate` Win32 desktop. It uses `PrintWindow` to compose a PNG; it **never uses a screenshot of the owner's Default desktop**. When the configured AI default target is `private_desktop`, the legacy `windows.screenshot` tool rejects physical/default desktop screenshots with `AI_PHYSICAL_SCREEN_CAPTURE_NOT_ISOLATED`. The AI should use `windows.private_screen.capture` instead; without a selector it captures all private-screen monitor regions. Legacy physical capture remains available only outside private AI default mode.

- **No selector:** `source: "desktop"` (also the default) renders **all connected host displays** in a single PNG. The union includes any negative X/Y coordinates for displays to the left or above the primary.
- **One display:** `source: "monitor", monitor_index: 0` or `source: "monitor", monitor_id: "\\\\.\\DISPLAY2"`. IDs come from the capture metadata. Index 0 is valid; use IDs if ordering may change.
- **One window:** `source: "window", hwnd: "0x..."` and the handle must belong to a top-level `NexowirePrivate` window. The local WPF Viewer now lists private windows with exact HWNDs. Select a private window and click **PREVIEW WINDOW** to show only its current content. The **ALL SCREENS** button restores the combined preview even if the selected window has since closed. These buttons never activate the HWND, move the user's physical cursor, or switch the input desktop. Invalid HWNDs never capture the owner's physical desktop. If a previously valid selected private window closes, the Viewer recognizes `WINDOW_NOT_PRIVATE_DESKTOP`, clears the stale selection, and retries once with the combined private-desktop capture. Likewise, a disconnected selected host monitor (`PRIVATE_MONITOR_NOT_FOUND`) restores all-screen preview. A visible `PREVIEW SCOPE` notice records the automatic recovery; rendering failures, capture timeouts and other errors remain explicit and do not silently become a healthy preview.
- Invalid, absent, or conflicting selectors **fail closed**, never silently fall back to all screens.
- PNG output bounds `max_width` and `max_height` are **downscale limits**, not instructions to change Windows display resolution.
- PNG `max_bytes` is an enforced limit. Native desktop source bitmaps above 120 megapixels fail with an explicit error rather than allocating unbounded memory.
- An existing but empty NexowirePrivate desktop or monitor region returns a valid background-only PNG with `emptyCaptureArea: true` and `capturedWindows: 0`. This is not a screenshot of the owner's Default desktop. When visible private windows exist but all rendering attempts fail, the capture still fails explicitly. The Viewer reports `LIVE EMPTY AI SCREEN` for a fresh empty capture, separately from capture errors or stale frames.

### Returned metadata

`source`, `monitorCount`, `monitors[]`, `selectedMonitorIndex` (null for all/window), `captureBounds`, `topologyKind: "host_shared_native"`, `perMonitorDpiAwarenessApplied`, `sourceWidth`, `sourceHeight`, PNG dimensions, scaling, window counts, and before/after input desktop.

Each `monitors[]` entry includes `index`, Windows `id` (`\\.\\DISPLAY...`), `x`, `y`, `width`, `height`, `primary`, `effectiveDpiX`, and `effectiveDpiY`. DPI values are nullable if Windows cannot retrieve them. The DPI-awareness flag reports whether the helper successfully requested per-monitor awareness.

### Important isolation boundary

Win32 *desktop objects* are **not** display adapters or virtual monitors. They share Windows session display topology and DPI policies with the owner's desktop. Changing native monitor count, resolution, scaling, or arrangement would change the user's environment and is **not** a supported private AI operation.

The following requested independent AI settings remain **unimplemented** until there is an isolated, verified virtual-display backend (e.g. a signed Indirect Display Driver plus a session/container design that cannot modify the owner's visible arrangement):

1. AI-selectable virtual display count (including headless systems).
2. Independent per-display mode, resolution, refresh rate, and scale/DPI.
3. Display hotplug and stable IDs, virtual coordinate placement, cross-monitor window routing.
4. Screenshot of all independent AI screens by default; exact one-screen selection when requested.
5. Hotplug/mode-change rollback and visible-owner-foreground/cursor invariants.

Do not misrepresent image resampling or a split canvas as a real independent virtual monitor, and never use host `ChangeDisplaySettingsEx`/`SetDisplayConfig` to fulfill an AI-private display request.
