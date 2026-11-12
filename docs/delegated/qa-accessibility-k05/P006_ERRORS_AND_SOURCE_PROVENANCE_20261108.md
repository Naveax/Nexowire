# P006 T-559…T-564: distinct HTTP errors and trustworthy UI test evidence

Date: 2026-11-08 (Europe/Istanbul). Owner: K05, source-only independent QA for [issue #539](https://github.com/Naveax/Nexowire/issues/539), [issue #485](https://github.com/Naveax/Nexowire/issues/485), and [issue #1006](https://github.com/Naveax/Nexowire/issues/1006). No protected or owner web/CI file changed.

## Exact source boundaries

| Source | Exact SHA | Usage |
|---|---|---|
| Upstream `main` | `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` | 2026-11-08 `git ls-remote` and local `upstream/main` snapshot. |
| Owner web [Draft #1068](https://github.com/Naveax/Nexowire/pull/1068) | `94d38799e9e4b50fe84f7924e6fc84f90aeba090` | Read-only candidate checkout. Remains unmerged at inspection. |
| Owner CORE/CI [Draft #1096](https://github.com/Naveax/Nexowire/pull/1096) | `e879ecb8e70a0e798c73c6028400b11e3e8bb4e7` | Read-only owner boundary. |
| Existing K05 [PR #1132](https://github.com/Naveax/Nexowire/pull/1132) | `1f1d912b164a01485abdf3b56cfe62fa37752955` | Earlier independent source/CI evidence, **not** imported as a dependency in these new tests. |

## T-559: 429, 401, 403 must not collapse to one story

The `node:vm` harness executes the actual `web/admin.js` code with an isolated fake DOM and fake `fetch` returning the supplied HTTP status (no server, credentials or live account). For **401 unauthorized**, **403 forbidden**, and **429 rate-limited**, both current `main` and the exact #1068 candidate display `#admin-pill = Offline`. That is a misleading transport diagnosis for an authorization/rate-limit HTTP response. The `#admin-error-message` text still contains the status, so this is a display/status mapping issue, not proof of a successful unauthorized action.

Current `main` additionally lacks explicit `role="alert"` on the admin error region; #1068 adds it but leaves the `Offline` pill. `web/connect.js` pairing rejection treats HTTP 429 like a generic failed pairing; the candidate adds error/retry focus but does not yet distinguish 429. This scanner separately rejects a forged successful pill, invisible/empty alert, absent focus/readback and a generic 429. K04 owns admin source (and [PR #1104](https://github.com/Naveax/Nexowire/pull/1104)); K01 owns connect UI. Owner authentication/authorization policy is not changed.

## T-560: two visible devices may have the same name

Current `main` has no ordinal source `deviceLabel`, whereas #1068 candidate computes `device.name + ' · cihaz ' + (devices.indexOf(device) + 1)` and scopes the accessible action labels. A negative fixture replaces the index with zero and is rejected. K03/K15 need to verify two actual `Depo` devices, accessible name uniqueness and correct target selection on the real UI; source patterns cannot prove device authorization/identity or prevent wrong-device action by themselves.

## T-561: viewport and focus order

Three requested widths are **320, 375, 768 CSS px**. The source checker covers viewport metadata, 620px breakpoint and long error text wrapping. Actual tab order, focus return, horizontal scrolling, zoom and screen-reader announcement at each viewport are all **NOT_RUN**. Current main is missing explicit `.error-panel` `overflow-wrap:anywhere`, #1068 candidate includes it. This is a source CSS observation, not a physical clipping claim.

## T-562: exact PR source and test-run identity

Independent validator requires each test sample to match the specified PR source SHA, have a named `.test.mjs/.test.ts` file, and, when claiming hosted PASS, a recorded matching run HEAD SHA, run ID, real invocation indicator and successful run conclusion. It rejects cases that combine green jobs from one PR with uninvoked tests or source files from another PR. Physical PASS requires a distinct artifact reference. It does not query GitHub itself; the caller must supply independently verified run/step information. A boolean alone is not proof of invocation.

## T-563: long Turkish error strings

The fixture has more than 1,000 Unicode characters, including Turkish diacritics and combining-normalized text. Error message ID, named retry button and `.error-panel` word wrapping are tested independently, with empty-label, missing-button and missing-wrap negatives. It does **not** prove that a 320px browser renders the element without clipping, nor that assistive technology speaks it once.

## T-564: source snapshots, not web ownership changes

The same scanner is run against the **exact baseline `main` checkout** and a **separate read-only #1068 HEAD**. Baseline findings: admin 401/403/429 collapsed to Offline, missing live error region, pairing 429 generic, pairing focus not proven, duplicate-device ordinal absent, explicit long error wrapping absent. #1068 candidate still has Offline and generic pairing 429, but source-level alert semantics, focus, ordinal labels, long text wrapping are improved. These are candidate differences, not yet merged product fixes or physical browser evidence.

## Reproduction and gates

From this PR's code worktree:

```sh
node --test test/delegated/k05/audit-p006-ui.test.mjs
node scripts/delegated/k05/audit-p006-ui.mjs .
node scripts/delegated/k05/audit-p006-ui.mjs /path/to/owner-1068-checkout
```

Automated **12/12 local tests PASS** against source + synthetic negative fixtures. The scanners intentionally exit **1** when actual source findings remain and must not be marked PASS. Other K05 baseline suites, where executed, are reported separately. K05 new test file's exact-head hosted discovery: **NOT_RUN** until verified by name in an actual CI step. Real browser, NVDA, Windows machine, 320/375/768px screenshots, pairing, remote two-PC operation and installed release: **NOT_RUN**. The open issue acceptance and owner merge gates are unchanged.

### Owner handoff

1. **K04:** `web/admin.js` and `web/admin.html`, main `52d452f…` versus #1068 `94d3879…`: 401/403/429 labels `Offline`. Distinguish HTTP error category and announce once; keep authentication policy unchanged.
2. **K01:** `web/connect.js` and `web/connect.html`, same SHAs: 429 pairing feedback is generic and focus differs by source; check deny/retry tab order and nested `#copy-status` live-region risk.
3. **K03/K15:** `web/app.js`, same SHAs: duplicate name ordinal present only in candidate; a two-device accessible action and identity run is still necessary.
4. **K13/ŞEF:** verify test path + exact SHA + run ID in CI; do not give the K05 P006 test hosted credit just because earlier [PR #1132](https://github.com/Naveax/Nexowire/pull/1132) globally passed workflow jobs.
