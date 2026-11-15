# SHA-bound test execution planning (#1205)

This planning-only command builds deterministic, bounded portable-root shards from
the **existing explicit approval list**. It does not execute tests or infer
safety from filenames. All remaining tracked test files are `NOT_REVIEWED_NO_EXECUTION`.

Run from the repository root:

```powershell
$env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
node scripts/ci/test-execution-plan.mjs --json --shards=2
node --test test/ci/test-execution-plan.test.mjs
```

CI must supply `NEXOWIRE_EXPECTED_COMMIT_SHA` matching the actual checked-out
source HEAD. The command uses a checked-in Git tree + index + worktree audit,
then verifies the SHA-256 test manifest and all per-file Git blob identities.

`--assert-all-reviewed` deliberately fails when any tracked test file lacks
explicit approval. Do not add this assertion as a successful default CI gate
until every test has actually been reviewed and isolated appropriately.

Only previously reviewed portable root files are eligible for shards.
Unreviewed files may require Linux, Windows, administrator permissions, network,
temporary databases, isolated fixtures, or physical acceptance: **nothing**
about those requirements is presumed. Shards describe potential work for an
isolated CI worker; they are not execution results or safety certification.

The report always states `executionPerformed=false`,
`executionCoverage=NOT_MEASURED`, and `physicalWindowsAcceptance=NOT_INFERRED`.
Do not run 635 test files blindly on the live Work-PC. This does not replace
the per-file TAP receipt or coverage reconciliation introduced in #1212.

Approved test paths additionally require exact pinned Git blob SHAs. Modifying an
approved test invalidates its prior review until the blob is explicitly re-reviewed.
The same map includes two hashes from the independently reviewed policy-store
root-test proposal; they are not selected unless the canonical receipt allowlist
also includes the matching paths. No path-only automatic promotion is allowed.
