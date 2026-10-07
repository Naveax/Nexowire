# Nexowire Screen — post-final architecture

Status: **planned for the first major feature after the current v1.0.2/final acceptance gate**. Do not let Screen work delay the existing release, two-PC acceptance, broker, updater, or rollback gates.

## Product intent

Nexowire Screen is a dedicated AI-operated visual workspace that behaves like a second monitor from the user's point of view. It is not merely a renamed screenshot viewer and it must not steal the user's physical mouse.

The target experience:

- the user keeps using the real Windows desktop and physical pointer;
- Nexowire owns a separate screen/workspace;
- apps can be launched and arranged on that screen;
- ChatGPT can see the screen continuously through a bounded capture path;
- the AI cursor is visually distinct and independently animated;
- AI pointer motion follows natural curved trajectories rather than teleporting or moving as a constant-speed straight line;
- the screen can be opened locally in a viewer, detached, resized, or left headless;
- every input/capture action remains attributable to the selected Nexowire device and workspace.

## Architecture stages

### S0 — contracts and simulator

- [ ] Define stable `nexowire.screen.*` capability names and structured state contracts.
- [ ] Add a deterministic geometry/path simulator so cursor motion can be tested without a Windows desktop.
- [ ] Define screen identity, bounds, DPI, refresh rate, capture generation and input generation.
- [ ] Add event/audit fields for screen ID, target window, path ID and frame generation.

### S1 — Screen workspace on existing isolation primitives

Build the first usable Screen from the already-shipped private desktop, private screen capture, private viewer and virtual pointer pieces.

- [ ] One persistent `NexowireScreen` workspace with explicit lifecycle.
- [ ] Window launch/list/focus/close confined to the Screen workspace.
- [ ] Continuous bounded capture with frame generation and stale-frame detection.
- [ ] Local viewer that looks like a monitor surface rather than the current diagnostic private-viewer window.
- [ ] AI pointer overlay rendered only inside the Screen surface.
- [ ] Independent private pointer/keyboard routing: do not move the physical Windows cursor.
- [ ] User can continue working on the physical desktop while the AI operates Screen.

### S2 — smooth AI cursor engine

The motion planner must be deterministic for a given path specification and independently testable.

- [ ] Cubic Bézier path generation between start and target with bounded control-point curvature.
- [ ] Minimum-jerk / ease-in-ease-out time parameterization so velocity and acceleration are continuous.
- [ ] Configurable speed, acceleration, curvature, overshoot and settle distance.
- [ ] Short moves collapse to a subtle eased segment instead of artificial loops.
- [ ] Long moves may use one or more curved segments; no teleport unless explicitly requested.
- [ ] Target approach slows down inside a configurable acquisition radius.
- [ ] Optional small correction segment after visual hit-test feedback.
- [ ] 60/120 Hz visual interpolation independent from the lower-rate MCP command stream.
- [ ] Path cancellation/replanning when the target moves.
- [ ] Cursor trail/label/theme remain visual-only and never become click targets.
- [ ] Record only bounded path metadata in audit logs; do not persist captured pixels by default.

Suggested normalized motion model:

`P(t) = cubicBezier(P0, C1, C2, P3, minimumJerk(t))`

with `minimumJerk(t) = 10t^3 - 15t^4 + 6t^5`, then clamp per-frame displacement to configured velocity/acceleration limits.

### S3 — optional real Windows virtual monitor

A true additional Windows monitor is a separate engineering track. Prefer the user-mode Windows Indirect Display Driver / IddCx path rather than hacks that falsify display topology.

- [ ] Prototype signed virtual-display package in a disposable test VM first.
- [ ] Make installation explicit and reversible; driver installation may require a one-time administrator approval.
- [ ] Screen appears in Windows display topology as a second monitor with its own resolution/DPI.
- [ ] Capture with Desktop Duplication or Windows Graphics Capture where supported.
- [ ] Do not use the OS global `SendInput` pointer as the default independent-AI input channel, because Windows exposes one global interactive pointer per desktop.
- [ ] Preserve the private-input path for independent AI interaction where a second system cursor is not natively representable.
- [ ] Prove uninstall restores display topology and leaves no phantom monitor.

### S4 — Screen UX

- [ ] Screen card in dashboard with Start / Stop / Open Viewer.
- [ ] Resolution presets plus custom width/height/DPI.
- [ ] 30/60/120 fps presentation targets with adaptive capture.
- [ ] AI cursor style, label, opacity, trail and motion profile.
- [ ] Motion profiles: Natural, Precise, Fast, Accessibility.
- [ ] Per-screen clipboard policy.
- [ ] Show which AI task currently owns the Screen.
- [ ] Emergency `Release Screen` action that stops input and returns the workspace to idle.

## Input policy

Nexowire Screen is specifically meant to avoid fighting the human for the real mouse.

1. Structured/UIA/browser controls remain preferred where they can verify the exact target.
2. Screen private pointer/keyboard actions operate only on Screen/private-window targets.
3. The visual AI cursor follows the planned curve and represents the AI action location.
4. Physical-console input remains a separate capability and follows the device SAFE/FULL access mode.
5. A future virtual-display driver does **not** imply a second independent Win32 global mouse pointer; that limitation must remain explicit in product claims.

## Acceptance gates

Screen is not `VERIFIED` until all of these pass:

- [ ] Physical mouse position is unchanged during 1,000 AI Screen pointer moves.
- [ ] Curve planner passes deterministic endpoint, velocity, acceleration and cancellation tests.
- [ ] No move leaves the declared screen/window bounds.
- [ ] 60 Hz cursor animation has no >100 ms unplanned stall during a 10-minute run.
- [ ] Viewer close/reopen does not destroy the Screen workspace.
- [ ] Screen restart does not leak overlay, host or capture processes.
- [ ] User desktop remains responsive during a 30-minute AI workload.
- [ ] Two PCs can run independent Screens simultaneously without cross-device state leakage.
- [ ] If the optional virtual monitor is installed, reboot/uninstall/rollback restores a clean Windows display topology.

## Order

Do not begin S1 implementation until the current FINAL gate is closed:

1. v1.0.2 release candidate and signed/checksum-pinned Windows artifacts.
2. Naveax + work-pc update/rollback validation.
3. Persistent SAFE/FULL authenticated production E2E.
4. Privileged Broker acceptance on each intended Full Access PC.
5. restart/reconnect/soak and final security regression.
6. **Then start Nexowire Screen S0/S1.**
