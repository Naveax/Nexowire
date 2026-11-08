# Issue #1006 / #539-R22 — first three verified green-but-uninvoked PRs

Evidence snapshot: 2026-11-08, checked against upstream current main
`b5a3f8840517d65ecbd6a018699c4c8bdde09987`. These are three
independently verified candidates, **not** a claim that all open Drafts were
enumerated or sorted. Each was still open and unmerged when checked.

| PR | Exact PR HEAD | CI run | Hosted jobs | Newly submitted tests lacking known main-CI invocation |
| --- | --- | --- | --- | --- |
| [#1111](https://github.com/Naveax/Nexowire/pull/1111) | `c5119a65a914ec339ad1c362ba9ba1ca19e339b4` | [42410254755](https://github.com/Naveax/Nexowire/actions/runs/42410254755) | 7/7 completed/success | `test/delegated/k19/issue588-large-file-acceptance.test.ts` |
| [#1124](https://github.com/Naveax/Nexowire/pull/1124) | `4d1a3dc32bd8c6718392ec743769c5409e114f3c` | [42411882607](https://github.com/Naveax/Nexowire/actions/runs/42411882607) | 7/7 completed/success | `test/delegated/k19/issue588-limits-inventory.test.ts` |
| [#1112](https://github.com/Naveax/Nexowire/pull/1112) | `3ca2cd12f003768ac66dea0f242b6b8007587101` | [42411620884](https://github.com/Naveax/Nexowire/actions/runs/42411620884) | 7/7 completed/success | `test/delegated/k13/main-ci-discovery.test.mjs`, `test/delegated/k13/main-ci-evidence-gate.test.mjs` |

GitHub's REST `runs/{id}` and `runs/{id}/jobs?per_page=100` returned the
named `CI` `pull_request` run, exact PR head SHA, `total_count=7`, and seven
completed/success jobs on **each**. This supports **hosted workflow PASS**,
not the execution of every newly added test. All four submitted test paths
are nested under `test/delegated/`; the current main workflow has no direct
invocation, and the default nonrecursive npm shell glob does not select them.
Until corresponding job output proves execution, submitted tests remain
**HOSTED_TEST_NOT_PROVEN** even when a job list is entirely green.

The reusable read-only filter and committed evidence fixture are:

```bash
node --test test/delegated/k13/p005-pr-ci-coverage.test.mjs
node scripts/delegated/k13/p005-pr-ci-coverage.mjs \
  test/delegated/k13/p005-pr-ci-candidates.fixture.json \
  .github/workflows/ci.yml package.json
```

The second command intentionally exits 1 for the **expected audit findings**
(`submitted_test_execution=NOT_PROVEN`), not because the old CI jobs failed.
No extra run was dispatched to obtain this snapshot.

## Handoff to K14 / owner CI integrator (T-472)

1. For #1111 and #1124, include the two K19 TS paths in a reviewed Node 22/24
   test command on the PR's future exact HEAD (or prove equivalent discovery).
2. For #1112, include both K13 MJS paths in a reviewed Node 22/24 command.
3. For the current K13 [#1134](https://github.com/Naveax/Nexowire/pull/1134),
   the new `p005-*.test.mjs` files run on a branch-scoped **fork auxiliary**
   runner, not upstream required main CI. See the separate actual run log.
4. Each PR's next exact-head run must be checked separately with a complete
   job list and actual executed-test logs. Do not combine PR and main-push
   jobs or reuse an earlier SHA. Physical Windows and production acceptance
   remain **NOT_RUN**.

No change is requested to owner #1096's protected `.github/workflows/ci.yml`
by K13. K14/ŞEF may pass these paths and evidence to that owner for review.
