# Nexowire Web shell

Provider-neutral static dashboard shell.

It intentionally has no embedded API keys, bearer tokens, billing secrets, or demo fallback data.

Expected authenticated endpoints:

- GET /api/v1/me/dashboard
- GET /api/v1/admin/overview
- /connect for the one-click device pairing flow

The static files can be hosted on a free static host. Authentication, metering, pairing, and admin authorization belong to the control-plane API and must fail closed when unavailable.

## Offline web smoke / evidence scope

From the repository root, with Node.js 22 or later:

```sh
node --test test/delegated/k10/offline-web-smoke.test.mjs
node scripts/delegated/k10/offline-web-smoke.mjs --json
```

The runner checks the three shipped public pages (`index.html`, `connect.html`,
`admin.html`) for basic markup, expected DOM anchors, duplicate IDs, and locally
resolvable CSS/JavaScript assets. It uses only built-in Node APIs, never makes a
network request, and returns a nonzero exit code if any **static** check fails.

The JSON report explicitly keeps these independent kinds of evidence separate:

| Evidence | Meaning |
| --- | --- |
| `static.status` | `PASS` or `FAIL` for the listed source-level checks only |
| `visual.status` | `NOT_RUN` until a separate browser run supplies real proof |
| `visual.scenarios` | 375×812 mobile, 768×1024 tablet, 1440×900 desktop for each page; candidate test cases, **not** screenshots |
| `visual.scenarios[].overflow` / `.keyboardFocus` | `NOT_RUN`; static inspection cannot prove layout or focus behavior |
| `accountAndDevice.status` | `NOT_RUN`; no authenticated endpoint, real Agent or Windows device is exercised |

For an actual visual acceptance pass, capture the page URL, exact Git commit,
browser/version, viewport, screenshot reference, horizontal-overflow result,
keyboard-focus order, and observed state (loading/empty/error/success) for each
scenario. Do not change a `NOT_RUN` field to `PASS` based on these source-level
checks. Account and device acceptance remains a separate test boundary.

An offline [state-case manifest](../test/delegated/k10/state-scenarios.json)
enumerates loading/empty/error/success for each page. Its anchor checks prove
the corresponding static IDs exist, **not** that a live API reaches or paints
those states. Visual verification and screenshot collection are still pending.

An **optional** browser runner is also available after Playwright and a local
Chromium executable have been installed separately:

```sh
node scripts/delegated/k10/browser-visual-smoke.mjs --out /tmp/nexowire-visual-smoke
```

Use a temporary output directory appropriate for your OS. The runner blocks
HTTP(S) requests, visits only `file://` pages, checks the PNG header and
viewport-sized dimensions, and evaluates horizontal overflow. It returns
`PARTIAL` even when all nine static screenshots succeed: API-rendered states,
real login, keyboard tab order, and device behavior remain `NOT_RUN`. Missing
Playwright/Chromium returns `NOT_RUN` with exit code 2; a detected screenshot
or overflow failure returns exit code 1. Generated PNG files are deliberately
not checked into the repository.
