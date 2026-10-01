---
manifest_version: 2
name: browser-session-inspection
description: Inspect existing Nexowire-owned browser sessions and page state without creating, navigating, or mutating browser content.
version: 0.1
requires: browser.session.list, browser.tabs, browser.snapshot
prefers: browser.screenshot, browser.visual.verify
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: browser, dom, inspection, visual, diagnostics
concurrency: parallel-safe
replay: safe
---

# Browser Session Inspection

Use this skill when a browser session already exists and you need evidence about its current page state without changing it.

## Workflow

1. List existing sessions with `browser_session_list`; never start a new session merely to inspect current state.
2. List tabs for the exact session.
3. If more than one page target exists, select the exact target ID instead of relying on ordering.
4. Read a bounded `browser_snapshot` for the relevant page.
5. Prefer structured DOM state for text, values, links, enabled/checked state, and selectors.
6. Use `browser_visual_verify` when one exact element needs DOM-backed plus cropped-pixel evidence.
7. Use `browser_screenshot` only when viewport-level visual context matters.
8. Correlate DOM and visual evidence before concluding that the page is ready, broken, blocked, or stale.

## Replay and concurrency

All required and preferred operations are read-only. Different existing sessions or page targets may be inspected in parallel, and interrupted inspection can be safely replayed.

## Rules

- Do not call navigation, click, set-value, start, or stop operations in this workflow.
- Password values stay suppressed; do not try to recover them from screenshots.
- A missing selector can mean the page changed, the wrong target was selected, or rendering is incomplete. Re-read page state before escalating.
