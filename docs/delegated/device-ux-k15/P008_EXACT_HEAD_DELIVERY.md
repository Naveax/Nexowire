# K15 P008 R-085–R-090: exact-HEAD review and CI discovery handoff

Date: 2026-11-12 (Europe/Istanbul). This is an **evidence update**, not a new source fix, browser pass, or upstream merge.

## Provenance

| Ref | Exact SHA / state |
| --- | --- |
| Upstream `Naveax/Nexowire:main` | `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`; compare with the P008 SHA: **identical, 0 commits ahead** |
| K15 existing Draft [#1110](https://github.com/Naveax/Nexowire/pull/1110) | `ba97e46cd8da93b217a4ee22c60be884ea3f9475`, open / not merged at review start |
| Owner UI Draft [#1068](https://github.com/Naveax/Nexowire/pull/1068) | `94d38799e9e4b50fe84f7924e6fc84f90aeba090`, open / not merged |
| Main `web/app.js` blob | `30ae81538b92fe8169031eccd1dbda41117d2f3c` |
| Owner `web/app.js` blob | `ab5b5d186ee6e1e3dab074952ffcadb153d6ef31` |
| Main `.github/workflows/ci.yml` blob | `90185b6f4297bc3e4feaca44817ed6a8248bd4be` |

## R-085: current source RED/acceptance boundaries

- Main `web/app.js:769-773` and owner `web/app.js:846-851` use `!response.ok` -> throw HTTP status -> generic `setPill('Bağlantı hatası', 'bad')`. Neither has a 403-specific status branch. This confirms the **implementation gap by code inspection**; it is not a newly executed browser repro. Existing K15 VM test previously recorded the 403 case as expected TODO, **not PASS**. Owner #1068 should distinguish an authenticated 403 permission denial from transport failure while continuing to protect old private device data.
- Main `web/app.js:747`, owner `web/app.js:817` set global green `Bağlı` after rendering an authenticated dashboard with **zero devices**; both files separately render `Henüz bağlı cihaz yok`. Source contract confuses dashboard session connectivity with paired-device presence. This is a wording/meaning decision for UI owner, not proof of incorrect backend pairing state.
- Owner `web/app.js:469-472` builds a same-named device accessible label using `devices.indexOf(device) + 1`. Ordinal changes with ordering even while `data-device-id` remains stable; review stable identity wording without changing target `deviceId` in requests.
- The existing dedicated Chromium runner `test/delegated/k15/chromium-device-ux.test.mjs` was previously **0 PASS / 1 SKIP / 0 FAIL** on its Linux host because Chromium process-singleton socket creation returned EPERM. It has not been executed in this review environment. Real 375px browser, keyboard, screen-reader, Windows/native grant and two physical devices remain **NOT_RUN**.

## R-086 / R-089: PR path uniqueness and consolidation

The six paths changed by existing PR #1110 are:

1. `docs/delegated/device-ux-k15/ISSUE_539_DEVICE_STATE_EVIDENCE.md`
2. `docs/delegated/device-ux-k15/P005_BROWSER_ACCEPTANCE.md`
3. `docs/delegated/device-ux-k15/P007_OWNER_UI_BLOB_AUDIT.md`
4. `test/delegated/k15/chromium-device-ux.test.mjs`
5. `test/delegated/k15/issue-539-device-ux.test.mjs`
6. `test/delegated/k15/target-versus-permission-matrix.test.mjs`

All six file-path lookups return 404 on **both** upstream `main` and owner #1068 exact SHA. The 18 changed paths in #1068 have **0 exact-path overlap** with #1110. Thus this K15 QA surface is **new and path-disjoint**, not a full-path subset of the owner PR. Other agents' UI tests may overlap in *scenario*; this check does not prove semantic uniqueness of every assertion. Preserve the K15 identity/permission/Chromium negatives while evaluating actual redundant assertions before consolidation. No existing source or test was deleted.

## R-088: exact-HEAD CI, independently checked

K15 PR SHA `ba97e46cd8da93b217a4ee22c60be884ea3f9475`: automatic upstream [CI run 42528185765](https://github.com/Naveax/Nexowire/actions/runs/42528185765) completed **success, 7/7 jobs**:

- Node 22 `test (22)` job **128876373575**: success.
- Node 24 `test (24)` job **128876373957**: success.
- `browser-live` job **128876374114**: success, but executes `test/browser-live.test.ts` and unrelated Windows test lists, not the K15 isolated Chromium test.
- Remaining four jobs: `wsl2-live`, `security-operational-live`, `linux-native-live`, `macos-agent-lifecycle-live`: success.

**Direct log audit** of Node22/Node24 and browser-live jobs: zero occurrences of any of these three K15 paths:
`test/delegated/k15/issue-539-device-ux.test.mjs`,
`test/delegated/k15/target-versus-permission-matrix.test.mjs`,
`test/delegated/k15/chromium-device-ux.test.mjs`.

Main `package.json` has `npm test = node --test --import tsx test/**/*.test.ts`, not a nested `.mjs` discovery pattern. Main `ci.yml` has zero `k15/` invocations. Hence **K15 hosted test execution: NOT_RUN**, even though generic 7/7 CI jobs passed. No CI rerun or workflow dispatch was requested.

## R-087 / R-090: next executable acceptance / owner request

1. **K13 / workflow owner #1096:** add approved explicit invocations for the three above K15 `.mjs` tests in the intended CI path on Node22/24, report exact SHA, workflow run, job ID and visible TAP result. Do not mistake `npm test` success for this coverage. This PR does not change protected CI.
2. **Owner UI #1068:** with current exact owner SHA, keep the existing stale-response privacy reset; add a distinct 403 permission-denied state and reliable recovery; align zero-device `Bağlı` label with account session vs device pairing; review whether ordinal accessible labels survive reordering. K15 currently supplies earlier VM negatives and a new but blocked Chromium harness, without changing owner source.
3. **Browser/Windows owner:** execute `K15_WEB_DIR=<owner web dir> K15_CHROMIUM=<installed chromium> node --test test/delegated/k15/chromium-device-ux.test.mjs` in a real browser-capable runner. Require a real non-skipped result, inspect 375px screenshot, keyboard/focus and duplicate-name accessible identities; still label native grant, pairing and two-device physical acceptance separately.
4. **ŞEF / Ömer:** retain #1110 as Draft until actual approval and review. Issues #539 / #485 / #812 / #1006 remain open; no issue close, owner merge, release or production operation.

### Evidence classification

- **Verified this review:** refs/states, source line inspection, exact-path 404 and changed file overlap, CI run 7/7, exact Node22/24/browser logs excluding K15, static `npm test`/workflow discovery.
- **Historical local source tests (not rerun this review):** main 12 PASS / 10 expected TODO, owner 19 PASS / 3 expected TODO, resolver 14 PASS; no new local test PASS credit.
- **NOT_RUN:** K15 hosted `.mjs` tests, real Chromium on this host, Windows focus/screen-reader/native consent, OAuth/pairing, live Agent/Broker, physical two-PC and owner merge.
