# Portable root-level test smoke (AI-11, issue #1205)

The old `npm test` Bash pattern omits the 574 test files directly under
`test/` when `globstar` is not enabled. Issue #1205 requires proper OS and
resource classification of all tracked tests before we change the default
test runner.

This is a **bounded first execution lane**, not a blanket "635 tests PASS":

- New hosted `Portable Root Test Smoke` workflow runs only on disposable
  `ubuntu-latest` runners, independently with Node 22 and 24.
- Exactly five reviewed root-level files are invoked explicitly:
  `test/version.test.ts`, `test/release-tag.test.ts`,
  `test/ai07-physical-cutover-gate.test.ts`,
  `test/capability-policy.test.ts`, and
  `test/device-routing-policy-store.test.ts`.
  The two policy-store suites create and remove **only isolated temporary
  fixture directories** on the disposable GitHub runner. No task, network,
  Broker, CORE, registry or production state is touched.
- It uses `npm ci`, serialized `--test-concurrency=1`, a bounded step timeout,
  no permissions beyond read-only repository contents, and fail-closed source
  and TAP receipt tests that check the allowlist and Git tracked-file inventory.
- The receipt runner executes each approved file in its own real Node subprocess
  with forced TAP output, rejects nonzero/partial/duplicate/skipped/missing
  summaries, and emits one JSON object binding executed file names and Git
  blob IDs to the exact commit SHA and full test inventory SHA-256.
  Hosted PR runs explicitly check out `github.event.pull_request.head.sha`
  instead of the synthetic PR merge commit, and the receipt fails closed when
  Git's checked-out `HEAD` does not match the expected SHA supplied by GitHub.
  This prevents a passing merge-ref receipt from being mislabeled exact PR HEAD.
  The receipt prints to CI logs; it does not write to protected production paths.
- This is a **root-level test execution proof only for the exact five files**.
  It does not certify the remaining tracked files, any production Windows
  privilege, or physical SYSTEM cutover.
- Never enlarge this allowlist without reviewing imported modules, side effects,
  resource budgets and runner isolation. Windows protected-task tests remain
  in dedicated hosted Windows CI with the real visibility NO-GO checks.

Locally inspect the plan without running broad side-effectful tests:

```sh
node scripts/ci/test-inventory.mjs --json
node --test test/ci/portable-root-smoke-contract.test.mjs
node --test test/ci/portable-root-execution-receipt.test.mjs
```

Full execution coverage stays OPEN under #1205. Do not treat absent tests as
green, silently skip failures or change CORE/STOP or protected production state
to satisfy a suite.

## Hosted TAP execution + immutable inventory reconciliation

The hosted Node 22/24 Portable Root Test Smoke workflow executes
`scripts/ci/portable-root-coverage-gate.mjs --json`. This invokes the existing
exact-reviewed-file TAP runner and the independently tested immutable Git
inventory reconciler within one fail-closed job. The output preserves the
per-file TAP receipt, Git blob SHA, source HEAD SHA, full inventory manifest
SHA-256, and **all** explicitly NOT_RUN test paths. CI runs its negative
contracts before this bounded step.

To repeat the same read-only check locally:

```powershell
$env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
node --test test/ci/portable-root-coverage-gate.test.mjs
node scripts/ci/portable-root-coverage-gate.mjs --json
```

Only the five reviewed portable root files are executed. There is no
automatic promotion of unreviewed files, no broad npm-test invocation, no
privileged Windows action, and no assertion that physical SYSTEM cutover
or all tracked files have passed. A coverage count is not authorization.
