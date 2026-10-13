# AI Screen independent-display profile contract

## Tool: `windows_private_display_plan` (read-only)

The assistant can describe a proposed **isolated** arrangement of 1–8 OS-visible AI displays with resolution, effective DPI and refresh rate. The tool validates and normalizes each request into stable IDs and nonoverlapping geometry.

Example:

```json
{
  "screen_count": 3,
  "width": 1920,
  "height": 1080,
  "dpi": 96,
  "refresh_hz": 60,
  "layout": "horizontal",
  "primary_index": 1,
  "per_monitor": [
    {"index": 1, "width": 2560, "height": 1440, "dpi": 144, "refresh_hz": 144},
    {"index": 2, "width": 1280, "height": 1024, "dpi": 120}
  ]
}
```

The returned plan includes `monitors[]` with `AI-1`, `AI-2`, etc, each one's `x,y,width,height,dpi,scalePercent,refreshHz`, primary index and union rectangle. DPI-to-scale is recorded as a requested percentage from 96 DPI. The plan checks monitor references, duplicates, bounds, dimensions, refresh and DPI. Invalid input is rejected instead of silently reducing monitor count. Layouts exceeding 120 million pixels or 32767 px along an axis are rejected prior to any backend activation.

### Screenshot selection design

The intended independent-display capture policy is explicitly part of every plan:

- Default: `all_monitors`. A screenshot includes every AI display unless a selector was given.
- Explicit: `monitor_index_or_id` captures only that AI screen.
- Display enumeration contains stable IDs and offset geometry.

This is a **future provider contract**; it is not a claim that independent OS monitors are already captured. Present `windows_private_screen_capture` captures the existing shared host topology only.

### Backend activation (not implemented)

Every response always reports `applied:false`, `osMonitorsProvisioned:false`, `touchesHostDisplaySettings:false` and `ISOLATED_VIRTUAL_DISPLAY_BACKEND_REQUIRED`.

Because a Win32 desktop object shares Windows session monitor configuration, connecting additional monitors through the same session's display driver is **not isolated** from the owner. The future backend must create genuinely independent display topology in an isolated VM/session or a similarly proven boundary, with safe provisioning, ownership, reattachment, cleanup and rollback. It must not call host display mode APIs against the owner's active environment.

This planner never changes registry values, host DPI, monitor arrangements, input desktops, foreground windows, tasks, driver installations or Windows device state.
