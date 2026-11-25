# K19 bounded local file transfer source acceptance — 2026-11-17

## Reproducible source evidence

- Base: Draft PR #1160 at `f0359fd820a65629642e14a3248dd37eab9ef160`.
- Imported source-only test and historical matrix from Draft PR #1111 exact head `c5119a65a914ec339ad1c362ba9ba1ca19e339b4`.
- The new `test/delegated/k19/issue588-large-file-acceptance.test.ts` runs five local filesystem acceptance cases, including 221 KiB and 1 MiB synthetic payloads, bounded chunks, SHA-256 verification, interruption/no-overwrite/digest-negative outcomes. It did not contact a real second computer.
- Registered the test in the explicit delegated source-transfer CI lane, increasing expected assertion count from **404** to **409**.
- Reconciled candidate Git blob references in the 79/243/290-row source-preservation CSVs; historical source references remain preserved.
- `test/delegated/k13/p005-pr-ci-coverage.test.mjs` now recognizes that the *current integration CI source* references the PR #1111 test path, while still classifying the old PR's historical job execution as **not independently proven**.

## Local verification and limits

- Imported K19 suite: **5/5 PASS**.
- Expanded delegated lane on Work-PC: **409 total, 407 PASS, 0 FAIL, 2 SKIP**, where the two skipped tests require Windows file-symlink privileges and are not counted as passing tests.
- TypeScript and build PASS. Exact-head hosted Linux/Windows workflow must complete separately.
- Source tests do not resolve user-reported issue #588 end-to-end: no independently hashed destination on another authenticated device, no real WAN disconnect/resume test, and no proof of a release-ready two-PC experience.
- No installed Nexowire Agent, running Hub/Broker, SQLite, authentication state or protected SYSTEM task changed.
