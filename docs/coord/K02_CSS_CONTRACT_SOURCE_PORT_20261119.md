# K02 issue #485 / #539 CSS contracts: source-only CI port (2026-11-19)

Historic Draft PR [#1101](https://github.com/Naveax/Nexowire/pull/1101) contains unique source-only K02 regression `test/delegated/k02/issue-485-539-ui.contract.test.mjs` with exact Git blob `785012347534c211fd1f03653f9dff0497babab7`. Original test file is added **unchanged**. Production CSS/JS and existing fixture are not altered.

Reviewed current integration-parent CSS `web/styles.css` blob `15dd7e6a4e5a5d1a4a276647fee71bf40d619dd8` and existing `test/delegated/k02/overflow-fixtures.html` blob `283f98f61026e94a5f6517ad4ce6cbaa7c4c0775`. Using the regression's same static brace/media/declaration evaluation on actual CSS, reviewed 320/375/768px one-column grid and 640px zoom-width approximation, mobile flex-wrap, Unicode/error/status overflow-wrap, forced-colors focus outline and reduced-motion animation suppression; fixture contains expected Unicode, long URL, and disabled busy button. The original historical main CSS blob `d45d9445ba84361648f2544db243ff975b9ab21b` is not current; the CI lane also sets `NEXOWIRE_REQUIRE_UI_INTEGRATION=1` to forbid intentional historical SKIP. Six top-level TAP tests required to PASS with zero skipped/fail/todo.

Hosted Node 22/24 CI executes the exact unchanged file explicitly; no broad test glob, no real Chromium, live browser, real 200%/400% zoom, accessibility instrumentation, SYSTEM, Broker or device operations. A source parser approximates CSS cascade; it is not a browser layout engine.

Candidate source-provenance exact Git blob chain:
- CI `99c3f82f446fce0694a6cd5a22161b9b559f67ff` -> `e0d0ce2dabfc306a2daf5c1931701d23491b204b`
- Connection v2 matrix `b26d6d58b26611241d78094cafbf457730960236` -> `9d6d81c62a9473c8315bc62beb0f786c77995a4c`
- AI05 CORE matrix `c44904a74d04d64af79c21c032c62c11f27786c5` -> `5ef1ee6f903379dd1d0aed3446373d2af16fa688`
- Round2 matrix `18e6c4b2928ae46a9a9e00a5504b0b8738dd0b19` -> `aec49b4dc682f7fcd56ea4c41e70bad94e375d8c`

Original historical source blob IDs, row counts, and review classifications remain unchanged; candidate fields only are refreshed. This source port neither merges #1101 as a GitHub PR nor proves physical #1161 acceptance.
