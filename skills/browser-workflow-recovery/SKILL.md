---
name: browser-workflow-recovery
description: Recover a first-party Nexowire browser workflow after navigation, selector, popup, or state drift without falling back to blind screen clicks.
version: 1.0
requires: browser.session.list, browser.tabs, browser.snapshot, browser.navigate, browser.screenshot, browser.visual.verify
platforms: any
mutation: mixed
privilege: user
trust: trusted
tags: browser, recovery, automation, web
---

# Browser Workflow Recovery

Use this workflow when an existing Nexowire browser task loses its expected page, selector, or navigation state.

## Workflow

1. List current browser sessions and tabs before opening anything new.
2. Identify the intended page by URL/title and exact session/target ID.
3. Read a fresh `browser.snapshot`; do not reuse selectors from stale DOM state.
4. If the page navigated unexpectedly, determine whether it is:
   - expected redirect
   - authentication boundary
   - error page
   - popup/new tab
   - application state change
5. Re-select elements from the current snapshot.
6. Use a full `browser.screenshot` only when DOM state cannot explain the discrepancy.
7. Navigate again only when the desired URL/state is known and doing so will not discard unsaved user work.
8. After recovery, use exact-element visual verification or a fresh structured snapshot to prove the postcondition.

## Safety

- Do not blindly replay a click or form submission after an ambiguous disconnect.
- Treat payment, destructive, publish, send, submit, and account-security actions as non-replayable unless state is verified first.
- Do not expose password values from page state.
- Prefer DOM semantics over raw Windows pointer control for page content.
