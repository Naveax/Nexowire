---
name: windows-accessibility
description: Inspect and act through Windows UI Automation before falling back to screenshots or raw input.
version: 0.1
requires: windows.accessibility.tree, windows.accessibility.find, windows.accessibility.invoke, windows.accessibility.set_value, windows.window.list
platforms: win32
mutation: mixed
privilege: user
trust: reviewed
tags: windows, uia, gui, accessibility
---

# Windows Accessibility

Prefer UI Automation whenever an application exposes useful semantics. It gives the model names, control types, automation IDs, bounds, states, and supported patterns instead of forcing it to guess from pixels.

## Workflow

1. Resolve the exact application HWND with `windows_window_list`.
2. Inspect a bounded tree with `windows_accessibility_tree`.
3. Keep `include_values: false` unless text values are required. Password elements never expose their values.
4. Narrow a large tree with `windows_accessibility_find` using name fragments, exact automation IDs, class names, or control types.
5. For actions, build an exact selector that uniquely identifies one element.
6. Use `windows_accessibility_invoke` only for elements that expose InvokePattern.
7. Use `windows_accessibility_set_value` only for writable ValuePattern elements.
8. Re-read the relevant tree or application state after a mutation when later work depends on the result.

## Selector rules

- Action selectors are exact, not fuzzy.
- At least one selector field is mandatory.
- If zero elements match, the action fails.
- If multiple elements match, the action fails before mutation.
- Tree node IDs are response-local traversal IDs. They are not durable selectors and must not be reused as element identities.

## Data handling

- Tree size and depth are bounded.
- Value text is disabled by default and separately bounded when enabled.
- Elements marked as passwords never return ValuePattern text.
- Set-value responses return verification metadata and a SHA-256 of the submitted value rather than echoing the value.

## Fallback order

1. UI Automation.
2. Structured window and application state.
3. Screenshot plus visual reasoning.
4. Exact-foreground keyboard control.
5. Raw mouse coordinates only when no stronger semantic route exists.

## Safety

- Tree and find are read-only.
- Invoke and set-value are mutations and must not be automatically replayed after ambiguous transport failure.
- Applications can change their UI tree while being inspected. Re-query before acting if the window has navigated or materially changed.
- Some custom-rendered applications expose little or no UI Automation. That is a capability gap, not evidence that a control does not exist visually.
