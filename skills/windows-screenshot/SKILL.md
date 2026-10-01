---
name: windows-screenshot
description: Capture bounded Windows desktop or window screenshots as inline PNG images for visual verification without changing focus.
version: 0.1
requires: windows.screenshot
platforms: win32
mutation: read-only
privilege: user
trust: reviewed
tags: windows, screenshot, vision, gui
---

# Windows Screenshot

Use `windows_screenshot` when structured state is insufficient and the model needs to see the current desktop pixels.

## Workflow

1. Prefer structured OS/window APIs first.
2. For a specific application, use `windows_window_list` to resolve the exact HWND.
3. Capture `source: window` with that HWND, or use `primary_screen` / `virtual_desktop` when broader context is needed.
4. Keep `max_width`, `max_height`, and `max_bytes` bounded. Increase them only when small UI text genuinely requires more detail.
5. Use the returned image for verification before moving on to accessibility or input actions.

## Behavior

- Window capture reads the pixels currently visible inside the HWND rectangle. It does not focus, restore, reorder, or un-occlude the window.
- Desktop capture requires the native agent to run in a capturable interactive Windows session. Service/session-isolated agents return `SCREENSHOT_DESKTOP_UNAVAILABLE`.
- The MCP tool returns the PNG as image content. Base64 is removed from structured metadata so the JSON/text side stays compact.
- The result includes the capture rectangle, final dimensions, scaling information, byte size, SHA-256, and timestamp.

## Safety

- Screenshots can contain passwords, tokens, private chats, account data, or other sensitive information. Capture only the scope required for the task.
- Screenshot is read-only and may fail over between equivalent providers, but never treat visual pixels as proof that a prior mutation succeeded unless the relevant final state is actually visible.
- Prefer exact window capture over the full virtual desktop when a single application is sufficient.
