# Portable root-level test smoke (AI-11, issue #1205)

The old `npm test` Bash pattern omits the 574 test files directly under
`test/` when `globstar` is not enabled. Issue #1205 requires proper OS and
resource classification of all tracked tests before we change the default
test runner.

This is a **bounded first execution lane**, not a blanket "635 tests PASS":

- New hosted `Portable Root Test Smoke` workflow runs only on disposable
  `ubuntu-latest` runners, independently with Node 22 and 24.
- Exactly three reviewed, read-only root-level files are invoked explicitly:
  `test/version.test.ts`, `test/release-tag.test.ts`, and
  `test/ai07-physical-cutover-gate.test.ts`.
- It uses `npm ci`, serialized `--test-concurrency=1`, a bounded step timeout,
  no permissions beyond read-only repository contents, and a fail-fast source
  contract test that checks the allowlist and Git tracked-file inventory.
- This is a **root-level test execution proof only for the exact three files**.
  It does not certify the remaining tracked files, any production Windows
  privilege, or physical SYSTEM cutover.
- Never enlarge this allowlist without reviewing imported modules, side effects,
  resource budgets and runner isolation. Windows protected-task tests remain
  in dedicated hosted Windows CI with the real visibility NO-GO checks.

Locally inspect the plan without running broad side-effectful tests:

```sh
node scripts/ci/test-inventory.mjs --json
node --test test/ci/portable-root-smoke-contract.test.mjs
```

Full execution coverage stays OPEN under #1205. Do not treat absent tests as
green, silently skip failures or change CORE/STOP or protected production state
to satisfy a suite.
