# Issue #1006 / T-467-T-469 — source discovery versus actual execution

Snapshot: upstream/fork `main` at `b5a3f8840517d65ecbd6a018699c4c8bdde09987` (2026-11-08).
Source tree and `.github/workflows/ci.yml` were read from the same exact tree SHA.

## Current main CI source inventory

- 54 files under `test/delegated/**` match `.test.ts` or `.test.mjs`.
- 43 are explicitly referenced by `.github/workflows/ci.yml` or its K20 wildcard.
- Five direct `test/delegated/*.test.ts` files are selected by the Linux npm `test/**/*.test.ts` one-directory shell glob, but source selection is **not actual execution proof**.
- Six nested files have **no known invocation** in the current main workflow and cannot be selected by that default npm glob:

  1. `test/delegated/k09/roadmap-evidence.test.mjs`
  2. `test/delegated/k11/issue-487-commercial-unknown.test.ts`
  3. `test/delegated/k11/issue-487-meter-acceptance.test.ts`
  4. `test/delegated/k16/environment-doctor-contract.test.ts`
  5. `test/delegated/pool-k17/markdown-anchors.test.ts`
  6. `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`

The `npm test` script is `node --test --import tsx test/**/*.test.ts`.
On the Linux `sh` used by npm, without explicit recursive `globstar` support,
`**` expands one directory level. The isolated regression fixture in
`test/delegated/k13/p005-main-ci-inventory.test.mjs` verifies that
`test/delegated/direct.test.ts` expands while
`test/delegated/k16/nested.test.ts` does not.
No assumption is made about indirect imports or a future owner CI revision.

## Hosted evidence bridge (not required upstream CI)

The new branch-only `.github/workflows/delegated-noncore.yml` has two Linux
jobs (Node 22 and 24), read-only contents permission, no secrets, no trusted
PR-target event. A `push` to `k13/p005-ci-discovery` checks exact checkout
`HEAD == GITHUB_SHA`, runs inventory tests, prints the snapshot, and **explicitly**
runs the omitted K09 MJS and K16 nested TS regressions. TAP output must show
nonzero tests, zero failures, skips and TODOs. It proves only those files once
the actual job log confirms execution; it does **not** make all six missing
files covered, nor validate installed physical Windows devices.

The branch-only workflow is **auxiliary fork evidence**, not a substitute for
Naveax's required main CI. Owner PR #1096 owns `.github/workflows/ci.yml`:
the owner can integrate/review explicit invocation for the six paths, then
collect a new exact-HEAD run and logs. K13 does not modify the owner's file.

The prior [PR #1112](https://github.com/Naveax/Nexowire/pull/1112)
had a `completed/success` source CI with 7/7 job successes on its exact
head, but its new K13 MJS regression files were not explicitly invoked by
the main workflow, so their **hosted test execution remains NOT_PROVEN**.
The local 11/11 tests and any hosted 7/7 are separate claims.

Physical Windows, two-PC, live Agent/Hub, provider, release and production
acceptance: **NOT_RUN**. Source finding / runner success does not resolve
the underlying #1006 release gate.
