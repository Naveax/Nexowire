---
name: windows-window-control
description: Enumerate top-level Windows windows and focus one exact HWND with post-action foreground verification.
version: 0.1
requires: windows.window.list, windows.window.focus
---

# Windows Window Control

Use structured HWND tools before falling back to raw mouse coordinates.

## Workflow

1. Call `windows_window_list` with a narrow title/process filter when possible.
2. Select the exact HWND, not merely a title string. Titles are not unique and can change.
3. Inspect `processId`, `processName`, visibility, minimized state, foreground state, and rectangle before acting.
4. Use `windows_window_focus` on the exact HWND.
5. Treat success only as valid when `verified: true` and `foregroundHwnd` matches the requested HWND.

## Safety and reliability

- Focus is a UI mutation. Provider failover must not replay it after ambiguous transport failure.
- Windows can deny foreground activation because of foreground-lock rules. A failed verification is not success.
- Restoring a minimized window is optional and explicit.
- Prefer structured window focus over raw coordinate clicks. Coordinates should be a later fallback after visual/accessibility verification.
- HWNDs are ephemeral. Re-list windows after application restart or when a handle no longer exists.
