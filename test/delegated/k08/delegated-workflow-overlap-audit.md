# D-127 — K13 #1134 / #1149 delegated workflow overlap

Read-only evidence captured 2026-11-08, P007/V006. Ownership remains with
K13 and ŞEF. The comparison was made against exact Git commits, not PR titles
or a generalized green CI badge. K08 did **not** edit K13's scripts, tests,
workflow, source, or either PR; this report lives under K08-owned QA paths in
the already-open Draft [#1106](https://github.com/Naveax/Nexowire/pull/1106).

| K13 Draft | Exact branch HEAD | Relative to `main@52d452f` | Local Node 24 source QA | Required PR CI |
| --- | --- | --- | --- | --- |
| [#1134](https://github.com/Naveax/Nexowire/pull/1134) `k13/p005-ci-discovery` | `ec640fc144b1fe10e4a4490f353fd753eeaf3ad5` | 8 added paths, including auxiliary workflow | **12/12 PASS**, 0 fail/skip/todo | [42474504806](https://github.com/Naveax/Nexowire/actions/runs/42474504806): 7/7 returned jobs successful, but **not** proof its separately scoped auxiliary workflow executed |
| [#1149](https://github.com/Naveax/Nexowire/pull/1149) `k13/p006-ci-gap-seven` | `b6b5e60ba93f1a40fab432fedc06d334971a6c37` | 12 added paths, including 4 P006/P007 evidence and test-gate paths | **24/24 PASS**, 0 fail/skip/todo | [42514702344](https://github.com/Naveax/Nexowire/actions/runs/42514702344): **in_progress** at observation; no completed overall result asserted |

The two branch HEADs are **not ancestry-related**: their `merge-base` is
`b5a3f8840517d65ecbd6a018699c4c8bdde09987`. #1149 also incorporates
upstream `main@52d452f`, so a naive direct branch-to-branch diff shows newer
main's `src/ops/scale-s5-cost-envelope.ts` and K11 cost tests. Those are **not
K13's own newly proposed PR-file edits**: compare each branch using
`git diff --name-status origin/main...<branch>` and do not label those newer
upstream files K13 overlap.

## Same paths and differences

Both PRs add the **same eight K13 paths** relative to main:

1. `.github/workflows/delegated-noncore.yml`
2. `scripts/delegated/k13/P005_CI_DISCOVERY_EVIDENCE.md`
3. `scripts/delegated/k13/P005_PR_CI_CANDIDATES.md`
4. `scripts/delegated/k13/p005-main-ci-inventory.mjs`
5. `scripts/delegated/k13/p005-pr-ci-coverage.mjs`
6. `test/delegated/k13/p005-main-ci-inventory.test.mjs`
7. `test/delegated/k13/p005-pr-ci-candidates.fixture.json`
8. `test/delegated/k13/p005-pr-ci-coverage.test.mjs`

**Six of these eight overlapping files are byte-identical** across the two
exact heads (every shared file except the workflow and the branch-selector
assertion in `p005-main-ci-inventory.test.mjs`). The latter changes one regex:
`k13/p005-ci-discovery` → `k13/p006-ci-gap-seven`. It must agree with the
workflow's push branch filter, so copying only one of the two would cause the
source contract test to fail.

The shared workflow path differs **semantically**:

- #1134: `on.push.branches: ["k13/p005-ci-discovery"]`;
  `source-discovery` job, Node 22/24; explicit missing-test call covers only
  `test/delegated/k09/roadmap-evidence.test.mjs` and
  `test/delegated/k16/environment-doctor-contract.test.ts`.
- #1149: `on.push.branches: ["k13/p006-ci-gap-seven"]`;
  `seven-path-source-qa` job, Node 22/24; explicit test invocation covers
  **seven** paths: the two above plus
  `test/delegated/k11/issue-487-commercial-unknown.test.ts`,
  `test/delegated/k11/issue-487-meter-acceptance.test.ts`,
  `test/delegated/k11/p005-s5-evidence.test.ts`,
  `test/delegated/pool-k17/markdown-anchors.test.ts`, and
  `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`.
  Its new `p006-ci-gates.mjs` checks inventory and TAP evidence rather than
  relying on an unexplained fixed 41-test count.
- Both preserve the historical `pr1112-auxiliary` Node 22/24 jobs, pinned
  to source SHA `3ca2cd12f003768ac66dea0f242b6b8007587101`.
  These are **auxiliary historical evidence**, not a required check on the
  old #1112 PR head.

## What actually ran

K08 independently ran the checked-out **exact** branch sources:

```
#1134: node --test --test-reporter=tap \
  test/delegated/k13/p005-main-ci-inventory.test.mjs \
  test/delegated/k13/p005-pr-ci-coverage.test.mjs
# => 12 tests, 12 PASS, 0 FAIL/SKIP/TODO

#1149: node --test --test-reporter=tap \
  test/delegated/k13/p005-main-ci-inventory.test.mjs \
  test/delegated/k13/p005-pr-ci-coverage.test.mjs \
  test/delegated/k13/p006-ci-gates.test.mjs
# => 24 tests, 24 PASS, 0 FAIL/SKIP/TODO
```

On the fork, [auxiliary run 42514696323](https://github.com/SinsiVinci/Nexowire-fork/actions/runs/42514696323)
reports **four returned jobs completed/success**: `seven-path-source-qa`
(Node 22 and 24) and `pr1112-auxiliary` (Node 22 and 24). Both exact source
QA steps and the explicit seven-path step report success, **but this separate
push-scoped workflow is not the upstream required `.github/workflows/ci.yml`
test selection**. Do not interpret a 7/7 generic required CI result as proof
it invoked each of these seven paths, or this auxiliary workflow as a full
physical/installed-Agent acceptance. K08 did not independently run the seven
delegated TS tests locally; their hosted execution evidence is confined to
the explicitly named auxiliary jobs above.

## Owner handoff — disposition, not a merge

The **more complete #1149** is the sensible candidate to retain after K13
review because it includes #1134's six identical P005 files, adapts the
branch-selector assertion with the workflow, covers seven previously omitted
test paths instead of two, and preserves #1112's pinned auxiliary jobs. The
shared workflow path cannot be integrated from **both** branches unchecked:
one pushes the P005 branch, the other the P006 branch, and their test source
assertions depend on that choice. K13/ŞEF should choose one canonical
workflow and carry forward any unique evidence *before* an authorized close
recommendation for #1134; no automatic close or upstream merge from K08.

No new PR, CI dispatch, protected workflow edit, main merge, or issue close
was made. The seven paths' promotion into **required main CI** and any
physical Windows/Hub/Agent/provider acceptance remain separately unproven
by this D-127 report.
