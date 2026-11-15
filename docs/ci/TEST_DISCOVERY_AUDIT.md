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
immutable HEAD-tree Git blob IDs and paths, `trackedTsTestFiles`, `byDepth`,
and the `legacyBashGlob` one-directory match/miss counts. It requires the
Git index entries to match the committed HEAD tree, with no modified tracked
TypeScript test files in the working directory. Hosted pull-request runs check
out the exact PR head SHA (not GitHub's temporary merge ref) and supply that
expected SHA to the CLI, which fails closed on a mismatch. The inventory also checks
committed files exist and are regular files, rejecting symlinks, unsafe paths,
unmerged index entries and duplicate paths. A staged or unstaged test change
is **not** allowed to borrow the previous commit SHA as evidence.

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

## Execution coverage reconciliation (incremental, #1205)

The portable-root receipt covers a bounded, explicitly approved set, not all tests.
Reconcile a real execution receipt against the full immutable Git test inventory:

    $env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
    node scripts/ci/portable-root-execution-receipt.mjs --json > "$env:TEMP\nexowire-root-receipt.json"
    node scripts/ci/test-execution-coverage.mjs --receipt "$env:TEMP\nexowire-root-receipt.json"
    node --test test/ci/test-execution-coverage.test.mjs

The reconciliation checks exact source HEAD, manifest SHA256 and per-file Git blob,
rejects duplicates, non-committed files, skipped/failed/ambiguous counters, and
explicitly reports each NOT_RUN file. This is not an independent attestation of
execution, and cannot authenticate a fabricated receipt. It is not comprehensive
Windows, CORE, Broker, SYSTEM DPAPI, or physical cutover acceptance. CI requires
NEXOWIRE_EXPECTED_COMMIT_SHA. The CLI never starts privileged Windows tests.

## Source-bound manual review triage (incremental #1205)

To build a **non-authoritative** review queue for every tracked TypeScript test:

```powershell
$env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
node --test test/ci/test-review-triage.test.mjs
node scripts/ci/test-review-triage.mjs --summary
node scripts/ci/test-review-triage.mjs --json
```

The last command emits all pending paths, source Git blob SHAs, and textual
review signals. The summary prints bounded counts and a small sample only.
The repository source HEAD, index, manifest SHA-256, and each test's actual
working-copy Git blob are verified; malformed/different evidence fails closed.

Every file not in the exact approved portable-root allowlist has admission
`NOT_APPROVED_NO_EXECUTION`. The review hints include process execution,
network/listeners, file I/O, SQLite, Windows privilege vocabulary, environment,
native process and runtime module loading. These are **regular expressions**
over source text, not parsed call graphs or runtime traces. Comments and test
fixture strings can create false positives; obfuscation and indirect imports
can create false negatives. Even the lowest-hint category MUST be manually
reviewed before being added to an isolated, source-pinned test lane.

The pipeline does not run test files, grant Windows privileges, infer complete
test coverage, change production state or authorize SYSTEM Hub cutover.
Only use this triage to prioritize human source review; retain #1161 NO-GO.
