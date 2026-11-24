# NX AI-08 | Recompute full test manifest before reporting coverage

Date: 2026-11-23
Base: `b04bf428dd9cedc1a765d9194c17eb0c80df97c0` (#1160 Draft)
Linked issue: #1205
Scope: source-only / no physical Windows mutation / no release or tag

## Previously verified evidence

- Integrated parent #1160 exact-HEAD General CI #45190374159, Release Readiness #45190374558, AI-03 #45190374273, AI-04 #45190374372, Discovery #45190374144 and Portable Root #45190374173 all SUCCESS.
- Source inventory as of the parent: 654 tracked TypeScript test files (575 root, 46 immediate nested, 33 deeper). The legacy shell glob discovers only 46 without recursive glob expansion. Independent explicit lanes may execute additional files; **do not** infer their absence from the glob.
- Reviewed portable-root list: 35 files; all other tracked tests are NOT REVIEWED by that particular allowlist. That does not prove they are untested globally.
- Source-manifest SHA256 for this tracked TS inventory: `1f06592d2f0abd25f275601e5f934c3a09316b457b88423ff97f90fadc2167b9`.

## Issue fixed

The `reconcileCoverage(entries, inventory, receipt)` API checked the SHA labels in `inventory` and `receipt` and validated receipt-selected blobs against the allowlist, but did not **recompute the full inventory manifest** from the supplied entries. A changed unreviewed file path or blob could modify NOT_RUN output while the caller retained the old source-manifest SHA label and unchanged file count.

This branch recomputes the canonical test manifest (path/mode/Git blob and ordering), verifies its SHA256, count and depth distribution before using the receipt, and rejects any mismatch. Existing duplicate/invalid inventory errors still fail closed.

The result also contains a deterministic `fileStates` array and `statusCounts` object with PASS/FAIL/SKIP/NOT_RUN counts, explicitly bound to `RECEIPT_RECONCILIATION_ONLY`. Only file paths supported by the approved portable-root receipt are PASS; other tracked files are NOT_RUN **in this receipt only**. No inference is made about wider CI, physical Windows or actual unattended execution.

## New regression cases

1. Change an unreviewed tracked blob while preserving count and advertised manifest: **DENY**.
2. Replace a tracked unreviewed path with a synthetic path while preserving count: **DENY**.
3. Reorder source entries or change depth counters: **DENY**.
4. For valid receipt-subset evidence, every tracked file has one stable state; only reviewed receipt-selected paths are PASS, and all others are explicitly NOT_RUN.

## Verification

The release workflow already triggers on these two changed paths and runs `test/ci/test-execution-coverage.test.mjs` with Node 22 and 24 on an exact-head checkout. Inspect the child's *own* run ID and SHA. Do not inherit parent results; do not trigger duplicate workflows.

Optional offline operator commands against a disposable source checkout:

```sh
node --test test/ci/test-execution-coverage.test.mjs
# source-only reviewed execution requires the dependencies already installed
node scripts/ci/portable-root-execution-receipt.mjs --json > receipt.json
node scripts/ci/test-execution-coverage.mjs --receipt receipt.json
```

The latter execution runs the 35 explicitly reviewed suites and must never be taken as comprehensive coverage of all 654 tracked test files. Do not run unreviewed tests or physical privileged tests on Work-PC just to improve a percentage.

## Release and rollback

Continue #1160 as Draft / NO-GO until exact-source CI, disposable Windows acceptance, AI-09 physical acceptance and signed package/release gates are separately satisfied. Stable 1.0.9, `main`, production tasks, Hub/Agent/Broker/DPAPI/SQLite, manifests and source-preservation CSVs are untouched by this change.

Rollback is a revert of the coverage script, its associated MJS tests and this report on the child Draft branch. Existing accepted integration SHA remains untouched.
