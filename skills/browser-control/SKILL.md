---
name: browser-control
description: Use Nexowire-owned Edge/Chrome sessions through direct CDP for structured navigation, page inspection, exact selector actions, and visual verification.
version: 0.1
requires: browser.session.start, browser.session.list, browser.session.stop, browser.tabs, browser.navigate, browser.snapshot, browser.click, browser.set_value, browser.screenshot, browser.visual.verify
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: browser, cdp, web, gui
---

# Browser Control

Use Nexowire browser tools for web work instead of raw desktop clicks whenever the target is a web page.

## Workflow

1. Start an isolated browser session with `browser_session_start`.
2. Read `browser_tabs` when more than one page exists.
3. Navigate with `browser_navigate`.
4. Inspect the page with `browser_snapshot`.
5. Prefer the exact response-local CSS selectors returned by the snapshot.
6. Use `browser_set_value` for inputs, textareas, selects, and contenteditable elements.
7. Use `browser_click` only when the selector resolves to exactly one visible, enabled, hittable element.
8. Use `browser_visual_verify` after important actions when one exact element can prove the postcondition. It combines DOM-backed expectations, hit testing, and a cropped PNG for model inspection.
9. Use `browser_screenshot` only when the full viewport matters.
10. Stop sessions when the task is complete.

## Runtime

- Browser sessions are owned by the Nexowire native agent.
- Edge/Chrome is launched with an isolated temporary profile and loopback-only DevTools endpoint.
- Control is direct Chrome DevTools Protocol over Nexowire's existing WebSocket runtime.
- Remote Desktop Commander, SentinelX, Playwright services, Selenium grids, and browser SaaS are not involved.

## Safety

- Navigation accepts only HTTP(S) and `about:blank`; `file:`, `javascript:`, `data:`, FTP, and other schemes are rejected.
- Page snapshots are bounded.
- Password input values are never returned by snapshots.
- Selector actions fail closed on zero or multiple matches.
- Clicks verify the target center is actually hit by the selected element rather than an overlay.
- Set-value responses return length/hash metadata rather than echoing the submitted value.
- Visual verification fails closed on missing/ambiguous selectors, requires the element to be visible and hittable, bounds crop size, and returns explicit expectation pass/fail metadata.
- Browser mutations are not automatically replayed after ambiguous transport failure.

## Fallback order

1. Structured DOM snapshot/actions.
2. Browser screenshot and visual reasoning.
3. Windows UI Automation when browser chrome rather than page content must be controlled.
4. Exact-foreground keyboard.
5. Raw pointer as the final fallback.
