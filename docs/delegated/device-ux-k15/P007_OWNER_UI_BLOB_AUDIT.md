# P007 D-125 — #1068 owner UI source provenance (read-only)

Date: 2026-11-08 (Europe/Istanbul). Scope: issues #539, #485, #1006; existing K15 Draft #1110. This audit changes no UI/owner source, workflows, native permissions, or installed device.

## Exact refs and repeatable comparison

- Upstream main: `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` (verified by fetch); all seven UI web files below still differ from open #1068.
- Owner #1068: open Draft at `94d38799e9e4b50fe84f7924e6fc84f90aeba090`.
- Four source Drafts: #1010 `3f6a226e4244d3a599d9631adf69bb40bf1f4c92`, #1011 `6e740dfe919e5f615655f68815b078447915ce6f`, #1015 `2d448f69a996feeefcfa4b657af7f5249ba94681`, #1016 `96fa340b477915dc95dd4d8275c981b0a3b37f89`. All still open and unmerged at audit time.
- Read-only procedure: fetch `refs/pull/<number>/head` for the five PRs; enumerate each source branch's changed files against `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`, compare `git rev-parse <source-ref>:<path>` with `git rev-parse <owner-ref>:<path>` for every file; inspect changed blobs with `git diff <blob1> <blob2>`.

## 15 source paths: 12 byte-identical, 3 explicitly evolved

| Source | Path | Owner vs source | Difference where evolved |
| --- | --- | --- | --- |
| #1010 | `web/styles.css` | EXACT | — |
| #1010 | `test/delegated/k02/VIEWPORT_MATRIX.md` | EXACT | — |
| #1010 | `test/delegated/k02/overflow-fixtures.html` | EXACT | — |
| #1010 | `test/delegated/k02/responsive-css.test.ts` | EVOLVED | TypeScript tuple `as const` ensures strict inference; original `e5a635fa`, owner `b4377a81`. |
| #1011 | `web/connect.js` | EXACT | — |
| #1011 | `web/connect.html` | EXACT | — |
| #1011 | `test/delegated/k01/connect-state.test.ts` | EXACT | — |
| #1011 | `test/delegated/k01/ACCEPTANCE.md` | EXACT | — |
| #1015 | `web/admin.js` | EXACT | — |
| #1015 | `web/admin.html` | EXACT | — |
| #1015 | `test/delegated/k04/admin-a11y.test.mjs` | EXACT | — |
| #1015 | `test/delegated/k04/README.md` | EXACT | — |
| #1016 | `web/index.html` | EXACT | — |
| #1016 | `test/delegated/k03/panel-states.test.mjs` | EVOLVED | Additional test verifies a 401 clears folder editor, deletion control, and AUTO confirmation; original `d3ca48fa`, owner `60d0d92c`. |
| #1016 | `web/app.js` | EVOLVED | Dashboard reset clears old-account editor state, disables folder controls, hides AUTO confirmation; 401 resets selected folder; owner re-enables editor on valid render. Original `53f2d90a`, owner `ab5b5d18`. |

Source web paths belong to #1068/Ömer. Thus all four old PRs are **overlapping with owner #1068** and cannot be independently merged without owner review; the three evolved paths also mean the 15 source blobs are **not** all exact anymore. The three evolved hunks are additive and are not reverted by this K15 audit. #1068 also has other coordinator-owned CI/test changes; the table does not claim to cover its entire 18-file diff.

## CI and browser acceptance distinction

- K15 #1110 exact head `49b73758b2739015d21f51c7272ce6b032fc9b98`: upstream [CI run 42500611545](https://github.com/Naveax/Nexowire/actions/runs/42500611545) **completed success, 7/7 real jobs**. Job step-name review includes `test (22)`, `test (24)` and `browser-live`, but **no explicit** `test/delegated/k15/issue-539-device-ux.test.mjs` or `test/delegated/k15/target-versus-permission-matrix.test.mjs`. Those two K15 nested tests remain **HOSTED NOT_RUN / not demonstrated**.
- A job named `browser-live` executes `test/browser-live.test.ts`, but it does not demonstrate a K15 pairing screenshot, keyboard/screen reader accessibility, 403 permission message or signed native grant; these remain **NOT_RUN** for #1110.
- Previously executed local K15 source-only test suite (exact K15 tree unchanged in this audit): current main **12 PASS/10 expected TODO**, owner #1068 **19 PASS/3 expected TODO**, pure selector **14 PASS**. Do **not** promote this prior local result to fresh hosted/physical acceptance.

## Owner handoff / no-go

1. **#1068 owner:** retain the three evolved functional/test hunks; separately address previously demonstrated `403 -> Bağlantı hatası` misclassification and zero-device green `Bağlı` misleading session vs pairing wording; keep stable ID when device list order changes. Existing K15 source-negative evidence is in `ISSUE_539_DEVICE_STATE_EVIDENCE.md`.
2. **K13 / CI owner #1096:** explicitly invoke both K15 nested paths on an approved source commit and preserve TAP file-name/run/job evidence. General 7/7 success does not satisfy discovery.
3. **ŞEF / Ömer:** decide #1068 and old source PR supersession; no new PR, no upstream merge, no issue close or physical acceptance claim under V006. Nothing in this read-only blob comparison grants release/merge authority.
