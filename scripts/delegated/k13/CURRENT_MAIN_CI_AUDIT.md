# Issue #1006 / T-327 — current main delegated test discovery

Read-only snapshot: 2026-11-07. Upstream and fork `main` both
`4e7db16f4233048a956664bef6b607781eb63fb7`.

## Evidence levels

- [Actions run 42301635915](https://github.com/Naveax/Nexowire/actions/runs/42301635915):
  exact main SHA, `completed/success`; the Jobs endpoint returned **7 jobs**,
  each `completed/success`. Both `test (22)` and `test (24)` have explicit
  delegated batch steps with `success`.
- The current main tree has **52** files matching
  `test/delegated/**/*.test.{ts,mjs}`. A source-level comparison with
  `.github/workflows/ci.yml` found **43** directly mentioned or covered by the
  explicit `test/delegated/k20/*.test.mjs` shell glob. Nine are not directly
  named in the workflow.
- Among the first 20 **lexicographically sorted** delegated paths, **18** are
  directly referenced. This lexical definition is solely an audit sample, not
  evidence that these were historically the first 20 worker submissions.

## Missing explicit proof

- `test/delegated/k09/roadmap-evidence.test.mjs` is not named in main CI and
  `npm test` selects `.test.ts` paths. It has **no proven CI execution**.
- `test/delegated/k16/environment-doctor-contract.test.ts` is not named in
  `ci.yml`. Whether `test/**/*.test.ts` expansion includes this nested path
  needs independent exact-run discovery proof; **do not infer PASS**.
- Further paths not explicitly present:
  `test/delegated/pool-k17/markdown-anchors.test.ts`,
  `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`, and the five
  direct `test/delegated/*.test.ts` files. The TS files may be selected by
  `npm test`, but source naming alone is not execution evidence.

## Owner action / non-action

1. Coordinator / #1096 owns `.github/workflows/ci.yml`, so K13 made **no**
   edits there. Ask owner to make K09 MJS and any missing nested TS checks
   explicit (or prove equivalent discovery) in the reviewed CI integration.
2. Re-run only after that owner source change. Capture the **new exact SHA**,
   nonempty job list, actual test results and zero TODO/SKIP where appropriate.
3. Existing green main run proves the jobs that actually ran, **not** every
   discovered test and not physical Windows/production acceptance.

The accompanying `inspect-main-ci-discovery.mjs` is a conservative, read-only
source audit. `NPM_GLOB_UNVERIFIED` means precisely that, never PASS.
