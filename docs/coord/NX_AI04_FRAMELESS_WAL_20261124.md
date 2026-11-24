# AI-04 — frameless WAL / retained-index contradiction (2026-11-24)

## Independently observed gap
Base #1160 `d2696376aae7a23aa9e0df01c19aa5c9b07f0595`, original validator blob `11742f529242f343bc16918ee3723b34c0ecb7bd`. #1245 and composite #1250 are unchanged green source snapshots.

On an isolated Linux Node 22.16.0 SQLite fixture, a normal TRUNCATE checkpoint produced a zero-byte WAL and coherent SHM mxFrame=0, nBackfill=0. A subsequent committed UNKNOWN row existed only in an 8272-byte WAL (mxFrame=2, nBackfill=0). In separate disposable copies retaining the original DB and SHM, both a zero-byte WAL and a header-only (32-byte) WAL caused SQLite quick_check=ok but the WAL-only row was absent. The original validator unconditionally accepted an empty WAL after path stability and accepted a valid header with zero frames. This is a source-side data-preservation gap; no production incident or physical repair is inferred.

## Scoped change
- `src/agent/operation-journal-wal.ts`: require stable, coherent zero-frame index evidence when a frameless WAL retains SHM; deny contradictory frame/backfill counts, disagreement, malformed header or unstable file. Preserve legitimate zero-byte WAL after authentic TRUNCATE or a clean first read, and the no-index case. A zero-filled uninitialized index does not constitute a trusted anti-rollback witness.
- `test/agent/ai04-frameless-wal.test.ts`: six isolated SQLite cases: legitimate TRUNCATE, fresh read, empty allocation without SHM, zero/header-only WAL with still-committed index, and index-copy disagreement. Compare candidate DB/WAL/SHM bytes before/after; the SQLite oracle is a separate disposable copy.
- No existing test or workflow/provenance matrix changes. No automatic checkpoint/repair of an actual journal. The fixture-only checkpoint generates a known SQLite state.

## Acceptance
```sh
node --test --import tsx --test-concurrency=1 --test-reporter=tap test/agent/ai04-frameless-wal.test.ts
node --test --import tsx --test-concurrency=1 test/qa-journal-wal-recycle-p11.test.ts test/agent-operation-wal-integrity.test.ts test/agent-journal-restart-regression.test.ts
npm run typecheck
```

Exact-head Node22/24 CI and hosted Windows test execution required. The new one-level file is discoverable by Linux npm test; explicitly select it in reviewed Windows fixtures (AI-08 owns workflow). No PASS inferred before actual logs. Missing both sidecars or an attacker-controlled coherently rewritten index remains outside what local WAL structure can authenticate; independent rollback-resistant authority and native ownership remain necessary. Physical packaged Agent, reboot/recycle and actual cross-SID acceptance remain AI-09 NOT_RUN.

Rollback: revert this isolated follow-up commit if source review rejects it; do not roll back or modify the user's actual database. #974/#1001 stay open.
