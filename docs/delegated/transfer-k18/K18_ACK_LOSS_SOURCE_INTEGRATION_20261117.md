# K18 ACK-loss and S5 source evidence integration — 2026-11-17

## Exact source

- Source Draft PR: Naveax/Nexowire#1139, exact head `51d8400430dd0b78bee6afb300cfe44ac67e560d`.
- Candidate base: `1ae1a131a738fbfa086fcb5a5430022b8ecbb681` on integration Draft PR #1160.
- Imported **two** new independent source tests: `test/delegated/k18/capacity-evidence-compat.test.ts` and `test/delegated/k18/ingest-ack-loss.test.ts`. They cover negative capacity evidence labeling and local ingest with a synthetic lost final-chunk or incorrect-prefix acknowledgment.
- Both tests are explicitly discovered in the delegated CI source/transfer lane. Its expected test count was increased from **372 to 379**.
- Reconciled Git *candidate* blob pointers across 79-row `docs/connection-v2/source-preservation-matrix.csv`, 243-row `docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv` and 290-row `docs/coord/AI05_ROUND2_SOURCE_PRESERVATION.csv`. Historical source IDs remain unchanged.

## Verification

- New K18 tests: **7/7 PASS** on Work-PC with real local synthetic file I/O.
- Expanded explicit delegated CI suite: **379 tests**, 377 PASS / 0 FAIL / 2 SKIP on Windows (two unrelated file-symlink permission tests). Do not claim hosted Linux PASS until the new exact-head workflow is complete.
- TypeScript typecheck PASS and `git diff --check` PASS.
- This does **not** establish independent remote-device readback, end-to-end real external-network transfer, 2-PC ACK integrity, production provider pricing, or physical Windows SYSTEM/CORE cutover. These require separate acceptance.

Historical documentation and original Draft #1139 remain distinct from the integrated test paths. No running Agent, Hub, Broker, live SQLite database, or production service was changed.
