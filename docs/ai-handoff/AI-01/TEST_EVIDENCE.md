# AI-01 / TEST_EVIDENCE

## Source and historical evidence
- Base `main`: `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- GitHub source baseline: #954 merged, #957 closed unmerged; included by merged #978 in released 1.0.8.
- Current `test/agent-journal-restart-regression.test.ts` on main already independently generates **709 current + 295 old frames**, **473 commit frames**, **1,307 synthetic operation rows**, runs **six crash/restart iterations + one clean restart**, verifies UNKNOWN and duplicate-ID denial. AI-01 does not rewrite this shared/other-owner file.
- 2026-10-31 GitHub CI `41194627316` on `0f48b9e5bc1224dd34d5248525832a23845fdc0c`: typecheck **FAIL**, TS2532 in two new test lines. Fixed with subsequent commit; never counted as PASS.
- CI `41194708825` on `236b215a12dca04526ba1941f3d25efa026474a6`: Node22/24 succeeded; workflow **CANCELLED**, not 7/7.
- CI `41194972463` on `5779120499fac5982dc9ba1e7fbf528ce06c4a66`: Node24 test summary **2,331 / 2,039 PASS / 0 FAIL / 292 SKIP**; all eight AI-01 new tests PASS, Node22 PASS, Windows dedicated WAL+restart step PASS. At captured point the workflow was **6/7 SUCCESS, browser-live still in progress**, not a completed overall PASS.

## New tests in this commit (not yet validated by CI)
- Legitimate zero-size WAL accepted unchanged and without creating the DB.
- POSIX empty-WAL pathname swap at the first FileHandle.stat is denied.
- POSIX byte-identical, multi-frame recycled WAL pathname swap at late FileHandle.stat is denied.
- Windows rename-with-open-file behavior requires a separate native runner evaluation; two swap tests are explicitly SKIP on win32, **never physical PASS**.
- All tests operate on isolated disposable files, not a real Agent journal.

## Environment/evidence limits
- Source modifications and Git objects made via authenticated GitHub connector. No local clone exists in this runtime (github.com DNS unavailable), so local `npm run typecheck`, `npm run build`, or local `git diff --check` exit codes are **NOT RUN / NOT CLAIMED**.
- Current commit's exact-head CI workflow/job results must be verified from its own GitHub Actions run and appended to PR evidence; do not infer from earlier HEAD.
- No physical Windows restart, real WAL, user data, original credentials or CORE authorization accessed during AI-01.

## New pending exact-HEAD negative
- Source-review finding: an all-current WAL with a fully checksummed final frame whose DB-size commit marker is zero was accepted by the previous validator; SQLite can ignore this uncommitted suffix. New regression independently verifies every frame checksum after rewriting only the last commit marker and refuses mutation while retaining all snapshot bytes.
- Current staging parent `8e44c3aff6be486de8ffd0a9a9830243eaf7fbac`. This new commit has **NOT** been pushed to the PR branch or validated by CI yet; previous run `41196318562` was still active at the last check. Do not infer PASS or physical validation.
