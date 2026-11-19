# v1.0.9 — fail-closed reviewed test Git blob admission (2026-11-19)

## Problem

The portable test *planner* compared each of the 32 approved root-level test filenames against reviewed Git blob SHA-1 values. However, `createPortableRootReceipt`, the actual process launcher used by `portable-root-coverage-gate`, previously checked only the approved path and presence in the immutable test inventory. A new commit changing the content of an approved test file could therefore enter the launcher under the same filename before its source was reviewed again.

This is a distinction between **filename approval** and **content approval**; the former does not imply the latter.

## Implemented admission

- `scripts/ci/portable-root-execution-receipt.mjs` is now the single explicit owner of `REVIEWED_ROOT_GIT_BLOBS`. Its `assertReviewedRootGitBlobs(entries)` rejects absent filenames, modified reviewed Git blobs, duplicate inventory filenames or an invalid/duplicate allowlist.
- `createPortableRootReceipt` requires the immutable `readTestInventory` result to pass that check **before calling the first test subprocess**. The source-HEAD check remains independently required in hosted CI.
- `scripts/ci/test-execution-plan.mjs` imports the same pinned blob table instead of maintaining a separate copy. Its planning-only and fail-closed behavior is preserved.
- `test/ci/portable-root-execution-receipt.test.mjs` verifies positive source pins, negative modified/missing reviewed blobs, and a disposable Git checkout where all 32 approved filenames exist but contain unreviewed code. The injected runner is asserted to receive **zero calls** in this case.

## Scope of evidence

The reviewed portable-root lane still has **32 explicitly approved TypeScript test files**. The full source inventory has **650** tracked TypeScript test files at the parent HEAD; the remaining 618 files are not approved for this lane. They are *not* claimed to have never executed in other independent workflows.

The change does **not** change `npm test` discovery, authorize the other 618 files, execute privileged operations, edit production state, or establish physical SYSTEM Hub / DPAPI / SQLite cutover acceptance.

Initial local source/CI contracts: 50 PASS, 0 FAIL, 0 SKIP; TypeScript and build PASS. Exact-commit source-bound execution and hosted CI acceptance must be separately checked after committing.

This is a scoped improvement for issue #1205; that issue remains OPEN pending a comprehensive risk-reviewed execution matrix and reliable per-file receipts for every tracked suite.
