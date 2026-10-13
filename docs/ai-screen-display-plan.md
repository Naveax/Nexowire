# AI Screen independent-display profile contract

## Read-only isolated display backend preflight

Before attempting an isolated VM or guest display provider, call
`windows_private_display_backend_probe` to inspect prerequisite Windows host
capabilities without modifying the physical display topology:

- Whether a hypervisor is present and the VM management service is running
- Whether Hyper-V tooling is installed and the current Agent account can
  enumerate its VM inventory; inaccessible inventories report
  `access_denied_or_unavailable` with **no fabricated VM counts**
- **Effective process-token permissions:** `effectiveLocalAdministrator` and
  `effectiveHyperVAdministrator` are tri-state booleans that test *enabled*
  local Administrator and built-in Hyper-V Administrator roles in the actual
  Agent process token. UAC `deny only` membership does not count as enabled.
  Unknown inspection results are `null`, not a guessed `false`.
- `vmManagementAccessGuidance` is one of `HYPERV_TOOLS_MISSING`,
  `VM_MANAGEMENT_AVAILABLE`, or `REVIEW_AUTHORIZED_HYPERV_PERMISSIONS`.
  This is guidance, not proof that group membership is the sole blocker;
  delegated WMI/Hyper-V access policies can also affect `Get-VM`.
- Candidate host-shared virtual display adapters (for example, a Parsec
  Virtual Display Adapter), which are **not proof of isolation**

The result always reports `hostDisplayTopologyShared:true`,
`isolatedAiDisplayBackendReady:false`, `osDisplaysProvisioned:false`,
`touchesHostDisplaySettings:false` and the requirement
`ISOLATED_GUEST_DISPLAY_PROVIDER_AND_AUTHORIZATION`.

Even with a running Hyper-V service or an installed virtual adapter, no
independent AI monitor can be claimed until a separate authorized guest
provider has been built and verified. The preflight deliberately never
runs VM management mutations, installs drivers, attaches displays, or
changes physical resolution/DPI. It does not expose VM names or disk paths.

## Unified AI screen readiness report

Call `windows_private_display_readiness` to compare the saved AI monitor
profile against actual host-shared monitor topology and the read-only
virtualization preflight. It reports the **desired** count, resolution, DPI,
refresh and layout, the **observed** connected host monitor count/bounds,
and whether host resolutions happen to match the requested plan.

Even an exact resolution match is not proof of an independent AI display:
`canApplyDesiredIsolatedDisplays:false`,
`nativeHostMonitorsAreIndependentAiScreens:false`, and
`applied:false` remain explicit. No profile returns
`PROFILE_NOT_CONFIGURED`; missing Hyper-V/VM access produces distinct
blockers. `ISOLATED_DISPLAY_PROVIDER_NOT_INSTALLED` remains a blocker
until a separately authorized guest provider has been implemented.

This is a read-only diagnosis. The method does not start/stop VMs,
install adapters, capture owner Default windows, or change native
monitor count, resolution, DPI or the physical input desktop.

## Save the desired configuration for later sessions

The following Windows MCP tools persist **desired configuration only**:

- `windows_private_display_profile_set`: validate and atomically save 1–8 requested
  AI displays, per-monitor resolution, DPI, refresh rate, and arrangement. It
  rejects invalid topology before writing. The response always includes
  `applied:false`, `osMonitorsProvisioned:false` and
  `touchesHostDisplaySettings:false`.
- `windows_private_display_profile_status`: read the persisted profile and
  return the full derived layout with an explicit isolated-backend blocker;
  returns `configured:false` when no profile was saved. Corrupt files fail
  instead of silently selecting a different layout.
- `windows_private_display_profile_reset`: erase the saved profile intent
  only. It does not delete display drivers, alter monitor modes, or change
  the user's physical input desktop.

Repeated profile changes are supported. Within one running Agent, reads, writes, and resets are serialized so concurrent MCP requests cannot race the same Windows profile file. Profile replacement is atomic and transient Windows `EPERM`/`EACCES`/`EBUSY` rename conflicts receive a small bounded retry; invalid replacement requests leave the most recent valid profile intact. Concurrent updates from different Agent processes still require a dedicated cross-process transaction/lock protocol for strict write ordering.

Profiles live under the agent user's `~/.nexowire/private-display-profile`.
For isolated test fixtures, set `NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR`
to a disposable directory. The saved file is versioned and atomically replaced
rather than being partially overwritten.

A saved profile is **not a Windows monitor configuration**. Actual creation
of independent AI-visible monitors awaits an isolated session/virtual display
backend; a Win32 desktop alone does not provide that boundary.

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
