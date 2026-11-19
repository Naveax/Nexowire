# #1006 / #539-R22 — P006 CI discovery and false-green audit

Source snapshot: upstream and fork `main` SHA
`52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` (2026-11-08).
Owner PR [#1096](https://github.com/Naveax/Nexowire/pull/1096) owns
`.github/workflows/ci.yml`; this change does **not** edit that file.

## T-607 — actual main discovery after #1135 merge

The current main tree now contains **55** delegated `.test.ts/.test.mjs`
files, compared with 54 at earlier `main@b5a3f884`. The one newly merged
file is `test/delegated/k11/p005-s5-evidence.test.ts` from #1135.

Source-based classification of current main's workflow and `package.json`:

- 43 exact `.github/workflows/ci.yml` invocations or K20 wildcard matches.
- Five direct `test/delegated/*.test.ts` files can match npm's Linux
  `test/**/*.test.ts` single-directory shell glob (not proof of execution).
- **Seven** paths have no known invocation in main CI:

  1. `test/delegated/k09/roadmap-evidence.test.mjs`
  2. `test/delegated/k11/issue-487-commercial-unknown.test.ts`
  3. `test/delegated/k11/issue-487-meter-acceptance.test.ts`
  4. `test/delegated/k11/p005-s5-evidence.test.ts` (new after #1135)
  5. `test/delegated/k16/environment-doctor-contract.test.ts`
  6. `test/delegated/pool-k17/markdown-anchors.test.ts`
  7. `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`

This list is an audit of known source invocations, not a categorical assertion
that no dynamic import or undocumented run has ever loaded a path.
No current main-CI execution proof has been observed for these seven paths.

## T-608 — safe fork-only selected-test runner

The K13-owned `.github/workflows/delegated-noncore.yml` is scoped to pushes
on `k13/p006-ci-gap-seven` and has Node 22/24 Ubuntu jobs, with read-only
permissions, credential persistence disabled, no secrets or PR-target event.
Each job checks out the exact `GITHUB_SHA`, prints current source-inventory
counts, and invokes all seven paths explicitly. A TAP parser requires a
nonzero test count and equality `pass == tests`, with zero FAIL, SKIP, TODO.
This is **auxiliary fork evidence**, never a required upstream PR CI check.

## T-609 — fixed 41-test gate false RED (owner coordination)

Main `.github/workflows/ci.yml` runs `test/delegated/k20/*.test.mjs` but
uses hard-coded `grep -qx '# tests 41'` and `grep -qx '# pass 41'`.
Three **real exact-head** failure logs show the runner rejecting newer
successful TAP suites merely because their test counts differ:

| PR | Head SHA | Run / failed job | K20 TAP | Workflow result |
| --- | --- | --- | --- | --- |
| [#1118](https://github.com/Naveax/Nexowire/pull/1118) | `d51d9d4c2c25797405227bad223039c6b31055d2` | [42411030903](https://github.com/Naveax/Nexowire/actions/runs/42411030903), `test (22)` | **50/50 PASS**, `fail 0` | **FAIL**, fixed 41 grep |
| [#1130](https://github.com/Naveax/Nexowire/pull/1130) | `8a5bc56ebe1004595e4cebbd5bc363fe51892534` | [42412252743](https://github.com/Naveax/Nexowire/actions/runs/42412252743), `test (24)` | **48/48 PASS**, `fail 0` | **FAIL**, fixed 41 grep |
| [#1141](https://github.com/Naveax/Nexowire/pull/1141) | `a13dd68d0585d5f4b2617beb121702a2db7850ea` | [42474379692](https://github.com/Naveax/Nexowire/actions/runs/42474379692), `test (22)` | **52/52 PASS**, `fail 0` | **FAIL**, fixed 41 grep |

This is a CI gate bug, **not** evidence that all source tests passed the
overall workflow or were discovered. The whole job status is correctly FAIL.
No CI rerun was dispatched by K13. The owner can replace fixed 41 assertions
with a verified dynamic TAP gate: `tests > 0`, `pass == tests`, `fail=0`,
`skipped=0`, `todo=0`, and nonzero shell exit on any mismatch. K13's
`p006-ci-gates.mjs --tap` implements that contract only inside its own scope.

## T-610–T-612 — neither green runs nor pinned source are interchangeable

The offline negative tests reject completed green PR workflow jobs with no
actual selected-file execution list; unbound job run IDs; stale PR source
HEAD; cross-run or main-push event; and PR #1134-style pinned auxiliary
checkouts that have a **different workflow head SHA**. A pinned checkout can
prove test execution for that exact source code, but is not the original PR's
required CI check. `sourceInventory` / `classifyHostedEvidence` never
promote physical/device or release evidence from hosted smoke alone.

When a PR source HEAD changes, collect a **new** matching run and its selected
test list. Do not automatically dispatch another run for an existing SHA or
combine unrelated runs. Hand off the seven paths to K14/owner for reviewed
CI invocation or independent verified execution.

Real Windows work PC, two-PC user flow, live provider, production deployment,
release packaging and issue acceptance: **NOT_RUN**. A fork auxiliary PASS is
not issue #1006 closure or source PR merge approval.
