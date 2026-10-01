---
name: windows-input-control
description: Use the Windows clipboard plus exact-foreground Unicode typing and hotkeys without allowing keyboard input to drift into the wrong window.
version: 0.1
requires: windows.clipboard.read, windows.clipboard.write, windows.clipboard.clear, windows.keyboard.type, windows.keyboard.hotkey, windows.window.list, windows.window.focus
platforms: win32
mutation: mutation
privilege: user
trust: reviewed
tags: windows, keyboard, clipboard, input
---

# Windows Input Control

Use structured clipboard and keyboard tools instead of raw shell keystroke hacks.

## Workflow

1. Resolve the exact target HWND with `windows_window_list`.
2. Focus that HWND with `windows_window_focus` when necessary.
3. Type text only with `windows_keyboard_type`. The tool refuses to send anything unless the exact HWND is already foreground.
4. Send bounded chords with `windows_keyboard_hotkey`.
5. Use clipboard read/write only when clipboard semantics are actually useful. Keyboard text injection does not require clipboard mutation.
6. Re-list windows after application restart because HWNDs are ephemeral.

## Keyboard guarantees

- Text is injected as Unicode UTF-16 code units through Win32 `SendInput`.
- The target HWND must already be foreground. Nexowire never silently redirects keyboard input.
- Foreground state is checked before the injection and reported again afterward.
- Hotkeys support CTRL/CONTROL, SHIFT, ALT, WIN/WINDOWS, navigation/editing keys, A-Z, 0-9, and F1-F24.
- Duplicate and unsupported hotkey keys are rejected before input begins.

## Clipboard behavior

- Clipboard reads are bounded by `max_chars` and include truncation/hash metadata.
- Clipboard writes are verified by reading back the exact Unicode text.
- Clipboard clear is verified against remaining Unicode text.
- Clipboard contents can be sensitive. Do not read or echo them unless the task requires their contents.

## Safety

- Focus, typing, hotkeys, clipboard writes, and clipboard clear are mutations and are never automatically replayed after ambiguous provider failure.
- A failed foreground check means no keyboard input should be sent.
- Prefer exact-window keyboard control over global hotkey automation.
- Keep typed payloads bounded. Large file/content transfer belongs in file tools, not simulated typing.
