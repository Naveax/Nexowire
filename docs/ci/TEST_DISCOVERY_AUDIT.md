# TypeScript test discovery inventory (P1 / #1205)

## Why this exists

The legacy npm script passes `test/**/*.test.ts` to Node's test runner. On
Bash without `globstar`, that shell expression expands to tests exactly one
directory under `test/`. On other shells, expansion behavior may differ.
A green command therefore **does not** prove every tracked TypeScript test ran.

Use this read-only inventory to bind the full tracked test-file set to a Git
commit and produce an explicit discovery-coverage gap:

```sh
node scripts/ci/test-inventory.mjs --json
node scripts/ci/test-inventory.mjs --list
node --test test/ci/test-inventory.test.mjs
```

The JSON report includes `commitSha`, `manifestSha256` over sorted
Git index blob IDs and paths, `trackedTsTestFiles`, `byDepth`, and the
`legacyBashGlob` one-directory match/miss counts. The inventory checks
tracked files exist and are regular files, rejecting symlinks, unsafe paths,
unmerged index entries and duplicate paths.

```sh
node scripts/ci/test-inventory.mjs --assert-legacy-complete
```

The last command **intentionally exits nonzero** as long as the old Bash
discovery pattern omits any tracked TypeScript test. Do not turn this into a
passing release gate without changing the selection strategy and validating it.

## Interpretation and next steps

- `matchedWithoutGlobstar` means **eligible paths**, not tests executed,
  passing, or even running on the current OS.
- `omittedWithoutGlobstar` is a gap in the default Bash pattern, **not**
  necessarily an omission from every separately named CI job.
- Before replacing `npm test`, classify tests by OS, privileged effects,
  network dependencies and resource budget. Use a deterministic test manifest,
  bounded shards, explicit test files and exact-SHA TAP/JSON evidence.
- Do not run the entire tracked test inventory unsandboxed on the production
  Work-PC. Some tests require isolated fixtures or hosted Windows runners.
- Retain existing Windows, CORE, Broker, SQLite and SYSTEM Hub physical
  release fences. Test discovery never grants consent, privilege, deployment
  or physical reboot acceptance.

The audit is deliberately a first-stage, read-only diagnostic. Full portable
test execution coverage remains OPEN in issue #1205 until validated.
