---
name: windows-pointer-control
description: Use raw Windows pointer movement, clicks, and scrolling only as an exact-HWND fallback after semantic UI controls are unavailable.
version: 0.1
requires: windows.pointer.position, windows.pointer.move, windows.pointer.click, windows.pointer.scroll, windows.window.list, windows.window.focus
---

# Windows Pointer Control

Pointer control is the fallback layer, not the default. Prefer UI Automation, browser DOM actions, or exact keyboard operations whenever they can express the same intent.

## Workflow

1. Resolve the exact target HWND.
2. Focus it explicitly with `windows_window_focus` when needed.
3. Prefer coordinates derived from UI Automation bounds or a fresh screenshot.
4. Use `client_pixels` for exact client coordinates, or `normalized` values from 0 to 1 for scale-independent positions.
5. Read `windows_pointer_position` when you need the current screen/client cursor state or the HWND client origin.
6. Move with `windows_pointer_move`.
7. Click with `windows_pointer_click` only after the target point is known.
8. Scroll with `windows_pointer_scroll` at the relevant target point.
9. Re-verify visual or structured state after any pointer mutation that matters.

## Guardrails

- Pointer mutations require the requested HWND to be the current foreground top-level window.
- Client coordinates must stay inside the requested HWND.
- Before input, the resolved screen point must currently hit that same top-level window. Occluded points fail closed.
- Pointer placement is read back and verified after movement.
- A click is allowed to open another top-level window; post-action foreground state is reported but is not treated as automatic failure.
- Raw screen coordinates are intentionally not exposed for mutation.

## Coordinate modes

- `client_pixels`: integer X/Y inside the HWND client rectangle.
- `normalized`: X/Y in the inclusive range 0..1, mapped to the current client rectangle.

Normalized coordinates survive many resize/DPI changes better, while client pixels are useful when derived from exact accessibility or screenshot geometry.

## Safety

- Position reads are read-only.
- Move, click, and scroll are mutations and must never be automatically replayed after an ambiguous transport failure.
- Do not use raw pointer actions when a semantic UI action exists. Pixels are more fragile than control IDs, DOM selectors, or verified text values.
