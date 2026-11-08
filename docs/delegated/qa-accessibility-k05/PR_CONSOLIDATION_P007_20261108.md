# P007 / K05 — Existing-PR consolidation and accessibility QA

Date: 2026-11-08. Scope: independent source/fixture QA only; no owner `web/**`, CORE, Broker, auth, SQLite, WAL, CI workflow or release source modified.

## D-025 — PR descriptions and issue linkage

- Existing [#1115](https://github.com/Naveax/Nexowire/pull/1115) and [#1122](https://github.com/Naveax/Nexowire/pull/1122) metadata were checked after the ŞEF's edit. Their issue references are neutral; neither currently uses an issue auto-closing directive. See `ekip/PR_DENETIM_20261108.md` for independent audit.
- Issues [#539](https://github.com/Naveax/Nexowire/issues/539) and [#485](https://github.com/Naveax/Nexowire/issues/485) are **not resolved by these source-only QA fixtures**. Do not treat any K05 PR as issue acceptance or close an issue on its behalf.

## D-026 — Four PRs, one existing consolidation destination

The four previously opened PRs carry distinct file sets. This report and the nine unique files from #1115, #1122 and #1132 have been added to **existing PR #1146** (`k05/p006-a11y-20261108`); there is no fifth PR. The earlier PRs remain open for ŞEF/Ömer to decide whether to consolidate/close/merge them. No automatic or manual integration into `main` was performed.

| Existing PR | Original exact HEAD (at P007 inspection) | Generic CI run | Unique added suite | Files retained in #1146 |
| --- | --- | --- | --- | --- |
| [#1115](https://github.com/Naveax/Nexowire/pull/1115) | `2a74d9d2c0c42265c4ee27494eb530059904c0b3` | [42410556545](https://github.com/Naveax/Nexowire/actions/runs/42410556545) | `audit-owner-web.test.mjs` (9) | `ISSUES_539_485_20261107.md`, `audit-owner-web.mjs`, test |
| [#1122](https://github.com/Naveax/Nexowire/pull/1122) | `aaa96bde77bd6c4a03bc6b653be268727ee44f18` | [42411789831](https://github.com/Naveax/Nexowire/actions/runs/42411789831) | `verify-ui-test-provenance.test.mjs` (6) | `T382_UI_TEST_SOURCE_PROVENANCE_20261107.md`, `verify-ui-test-provenance.mjs`, test |
| [#1132](https://github.com/Naveax/Nexowire/pull/1132) | `1f1d912b164a01485abdf3b56cfe62fa37752955` | [42473898223](https://github.com/Naveax/Nexowire/actions/runs/42473898223) | `audit-p005-evidence.test.mjs` (8) | `P005_ISSUES_539_485_SOURCE_AND_CI_EVIDENCE.md`, `audit-p005-evidence.mjs`, test |
| [#1146](https://github.com/Naveax/Nexowire/pull/1146) | `7b3ba76538dc4e0beb5cb329fb1e9661291cc018` (before consolidation) | [42485334829](https://github.com/Naveax/Nexowire/actions/runs/42485334829) | `audit-p006-ui.test.mjs` (12) | Original `P006_ERRORS_AND_SOURCE_PROVENANCE_20261108.md`, `audit-p006-ui.mjs`, test, plus this consolidation |

The four listed original runs finished `completed/success` with 7/7 **generic** jobs; their green status does **not** demonstrate discovery or execution of these four new nested `.test.mjs` files. The new #1146 consolidated HEAD needs a *new exact-HEAD* hosted run before its CI status can be known. Never manually re-run CI for an already-running commit.

## D-027 — Negative findings on exact source checkouts

Upstream `main` source: `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`. Web owner candidate [#1068](https://github.com/Naveax/Nexowire/pull/1068): `94d38799e9e4b50fe84f7924e6fc84f90aeba090` (read-only source checkout).

| Source-only probe | `main` | Owner #1068 candidate | Delegated owner |
| --- | --- | --- | --- |
| `audit-owner-web.mjs` | exit 1; 12 findings including K01 nested live and K04 silent error | exit 1; 1 remaining K01 nested live | K01 nested; K04 admin |
| `audit-p005-evidence.mjs` | exit 1; 401/403 misreported as `Offline`, callback/focus and duplicate name concerns, new MJS not discovered | exit 1; 401/403 still misreported as `Offline`; focus fallback and MJS discovery open | K04 admin; K01 pairing; K13 discovery |
| `audit-p006-ui.mjs` | exit 1; 401/403/429 misreported as `Offline`, pairing 429, focus, duplicate names, long wrap | exit 1; 401/403/429 still misreported as `Offline`; pairing 429 not distinguished | K04/K01 |

All three scanner exits above are **intentional failing source findings**, **not PASS**. In isolation the `node:vm` admin 401/403/429 regression harness confirms that the status pill becomes `Offline`, even though the error is a denied or rate-limited HTTP response. #1068 improves the static admin alert semantics and duplicate device ordinal context, but the HTTP classification remains unresolved. Source candidates are not accepted UI fixes without owner verification.

## D-028 — Owner-facing QA and D-030 physical gates

- K02 touch/responsive: `320`, `375`, `768` CSS-pixel source matrix; long Turkish/Unicode content and `.error-panel` wrapping. These are fixture/source checks, **not measured viewport, focus, 200%-zoom, or touch-target results**. Real mobile, browser screenshots and pixel measurements: **NOT_RUN**.
- K04 admin: verify distinct 401/403 access denial, 429 rate limit and offline/network failure states, with an announced alert/status and retained action context. Source negative for `Offline` exists in `main` and #1068. Real network, keyboard, ARIA announcements and NVDA: **NOT_RUN**.
- K01: `connect.html` nested live regions and pairing 429 failure/focus need owner correction and screen-reader/browser testing. K03: duplicate device labels need real two-device and assistive-tech validation.
- Windows, NVDA/screen reader, 320/375/768 real browser, actual physical/mobile devices, live onboarding/rollback, full npm build/typecheck: **NOT_RUN**.

## D-029 — Tests actually executed, separate from generic CI

Command from the consolidated #1146 working tree:

```bash
node --test test/delegated/k05/audit-html.test.mjs test/delegated/k05/dynamic-id-contract.test.mjs test/delegated/pool-k05/touch-evidence.test.mjs test/delegated/k05/audit-owner-web.test.mjs test/delegated/k05/verify-ui-test-provenance.test.mjs test/delegated/k05/audit-p005-evidence.test.mjs test/delegated/k05/audit-p006-ui.test.mjs
```

**67/67 local Node tests PASS**, exit 0 (existing base 32 + distinct K05 additions 9 + 6 + 8 + 12). The independent provenance command `node scripts/delegated/k05/verify-ui-test-provenance.mjs --main 52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` reports **24/24 PASS**, one unchanged main web tree `fcd15697e51f0df9447cacfd826b549a25014ce9`, source digest `9a0c090763f04bf7fc41b6958b829b3786ccb174515448f71316ebbd3509661f`; it is a separate two-suite invocation, not 24 extra unique test cases. Generic hosted CI: **7/7 at the previous four source HEADs**, new consolidated HEAD CI **NOT_YET_PROVEN**, and nested MJS discovery **NOT_PROVEN**.

Acceptance status: **SOURCE_ONLY local evidence delivered**. Issues #539/#485, owner code, hosted nested test discovery, and physical device validation remain **OPEN / NOT_RUN**. See [#1006](https://github.com/Naveax/Nexowire/issues/1006) for ŞEF's integration/acceptance ledger.

## Adım 8 / D-138 — Four-state HTTP error negative contract

The existing `audit-p006-ui.mjs` source harness was extended (no owner source edit) to include **503 Service Unavailable**, in addition to 401, 403 and 429. An explicit `validateAdminHttpMatrix` fixture enforces four actual HTTP responses, visible status codes, non-success and announced error panels, and distinguishable throttling/service-outage status pills. 401 and 403 **may** share the same broad pill as long as their detailed HTTP codes remain different; this avoids prescribing UI copy. Explicit negative fixtures reject missing/duplicate/unexpected HTTP statuses, hidden errors, fake success, lost status code and the conflation of 429/503 with access denial or each other.

On exact source `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` and owner `#1068@94d38799e9e4b50fe84f7924e6fc84f90aeba090`, the actual `web/admin.js` returns `Offline` for **all four HTTP responses**, including 503; both scanners therefore exit 1 with source findings, not a successful owner fix. The owner candidate retains an announced error region (no missing role finding there) but the semantic status pill still collapses unrelated errors. K04 owns the UI correction; K01 owns pairing 429. Live transport behavior, NVDA and keyboard screen-reader announcement remain **NOT_RUN**.

Local command (all seven suites, after D-138 patch) reports **72/72 PASS** (previous 67 plus five D-138 regression tests), no ignored/skipped tests. `node --check` for the edited script and test and `git diff --check` PASS. This is local Node fixture verification, not actual browser acceptance. The previous #1146 consolidated HEAD `8980e181d16a5ab184cccf97405cfc0af4067922` has [CI run 42500820630](https://github.com/Naveax/Nexowire/actions/runs/42500820630) **completed/success**; jobs confirm the generic batch-3 step invokes only existing K05 `audit-html` and `dynamic-id-contract`, **not** the four newer K05 suite paths. The D-138 commit has a separate exact HEAD and must be evaluated on its own CI run; no manual rerun requested.
