# v1.0.9 — reviewed release-policy root test expansion (2026-11-19)

## Scope and source truth

Parent candidate SHA: `5bbc348f7bf99493928e03038d9133896ee8c85b`. This review adds two **read-only release workflow policy tests** to the explicitly approved portable-root list, increasing the reviewed lane from **30 to 32 files**. It does not change the legacy `npm test` shell glob, approve all tracked test files, publish a release, or execute privileged Windows migration.

New approved, source-bound test files:

| File | Git blob SHA | Manually reviewed scope |
| --- | --- | --- |
| `test/release-publication-policy.test.ts` | `d12ab1f03b7ffff8fc6d75552ada812d16b46436` | Only reads release workflow YAML and asserts authorized tag, GitHub CI SHA matching, permission scoping, and nonduplicate dispatch |
| `test/release-attestation-policy.test.ts` | `e1f12b6bceb5d437a8b46e194c953e83bc6aa923` | Only reads release-readiness YAML and validates tag-scoped attest/publish job constraints |

These two suites have no network calls, no filesystem writes, no subprocess spawning, and no skip branches. Their imports are Node's test/assertion and read-only filesystem/path APIs. No external dependencies are imported. Source changes to either entrypoint must require a fresh review because the planning allowlist pins their Git blobs exactly.

## Gate changes

- `scripts/ci/portable-root-execution-receipt.mjs`: explicitly approves only the two additional test filenames.
- `scripts/ci/test-execution-plan.mjs`: requires their exact Git blob SHA in the reviewed portable-root plan.
- `test/ci/portable-root-execution-receipt.test.mjs` and `test/ci/portable-root-smoke-contract.test.mjs`: update independent source allowlist assertions to 32, while retaining per-file TAP and workflow restrictions.
- `test/ci/test-execution-plan.test.mjs`: negative cases prove that changing either newly approved Git blob fails the reviewed source plan.

## Actual Work-PC execution

On DESKTOP-ONDD84S, the source-bound `scripts/ci/portable-root-coverage-gate.mjs --json` executed **32 tracked root test files with 177 PASS, 0 FAIL, 0 SKIP and 0 TODO**. The immutable source inventory contained **650** tracked TypeScript tests. The remaining **618** files were **NOT_RUN_IN_THIS_REVIEWED_LANE**, not claimed universally untested by all independent CI workflows.

The separate `pure-import-provenance` gate still covers its historically independently reviewed 25-file pure import subset; it is **not** claimed to cover all 32 tests. The newly added two files were read and manually scoped for this expansion. Cross-platform hosted CI for the new commit must independently pass before treating its review lane as hosted-accepted.

Full source/test coverage issue #1205 remains **OPEN**. Windows SYSTEM Hub / Broker, DPAPI, SQLite cutover, reboot and recovery acceptance issue #1161 remains **NOT_RUN** on the physical target.
