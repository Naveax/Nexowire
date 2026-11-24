# AI-04 — frameless WAL / retained-index contradiction (2026-11-24)

## Independently observed gap
Base #1160 `d2696376aae7a23aa9e0df01c19aa5c9b07f0595`, original validator blob `11742f529242f343bc16918ee3723b34c0ecb7bd`. #1245 and composite #1250 are unchanged green source snapshots.

On an isolated Linux Node 22.16.0 SQLite fixture, a normal TRUNCATE checkpoint produced a zero-byte WAL and coherent SHM mxFrame=0, nBackfill=0. A subsequent committed UNKNOWN row existed only in an 8272-byte WAL (mxFrame=2, nBackfill=0). In separate disposable copies retaining the original DB and SHM, both a zero-byte WAL and a header-only (32-byte) WAL caused SQLite quick_check=ok but the WAL-only row was absent. The original validator unconditionally accepted an empty WAL after path stability and accepted a valid header with zero frames. This is a source-side data-preservation gap; no production incident or physical repair is inferred.

## Scoped change
- `src/agent/operation-journal-wal.ts`: require stable, coherent zero-frame index evidence when a frameless WAL retains SHM; deny contradictory frame/backfill counts, disagreement, malformed header or unstable file. Preserve legitimate zero-byte WAL after authentic TRUNCATE or a clean first read, and the no-index case. A zero-filled uninitialized index does not constitute a trusted anti-rollback witness.
- `test/agent/ai04-frameless-wal.test.ts`: fourteen isolated SQLite cases (ten original plus four split-header cases): legitimate TRUNCATE, fresh read, empty allocation without SHM, zero/header-only WAL with still-committed index, index-copy disagreement, valid earlier-commit prefix truncation, legitimate WAL ahead of index, zero-filled uninitialized index, and nonzero backfill contradiction. Compare candidate DB/WAL/SHM bytes before/after; the SQLite oracle is a separate disposable copy.
- For a nonempty, fully checksummed WAL without old allocation tail, additionally reject either independently valid, checksummed index header of the same generation reporting more committed frames (or contradicting the final commit checksum at the same count). Missing, uninitialized, torn, unrelated-generation or lagging index without such contradictory evidence does not alone reject an otherwise valid full WAL. A split pair of independently valid headers must not hide positive commit evidence in either copy. The existing strict retained-generation reuse check is unchanged.
- No existing test or workflow/provenance matrix changes. No automatic checkpoint/repair of an actual journal. The fixture-only checkpoint generates a known SQLite state.

## Acceptance
```sh
node --test --import tsx --test-concurrency=1 --test-reporter=tap test/agent/ai04-frameless-wal.test.ts
node --test --import tsx --test-concurrency=1 test/qa-journal-wal-recycle-p11.test.ts test/agent-operation-wal-integrity.test.ts test/agent-journal-restart-regression.test.ts
npm run typecheck
```

Exact-head Node22/24 CI and hosted Windows test execution required. The new one-level file is discoverable by Linux npm test; explicitly select it in reviewed Windows fixtures (AI-08 owns workflow). No PASS inferred before actual logs. Missing both sidecars or an attacker-controlled coherently rewritten index remains outside what local WAL structure can authenticate; independent rollback-resistant authority and native ownership remain necessary. Physical packaged Agent, reboot/recycle and actual cross-SID acceptance remain AI-09 NOT_RUN.

Rollback: revert this isolated follow-up commit if source review rejects it; do not roll back or modify the user's actual database. #974/#1001 stay open.

## Local red/green evidence before hosted CI
- The initial six-case test file and exact original source were reconstructed with verified Git blobs. Node v22.16.0, TypeScript transpileModule (ESNext/ES2022), then Node test: original blob `11742f529242f343bc16918ee3723b34c0ecb7bd` 3 PASS / 3 FAIL; initial fix `5b3e96df3ba4807d31619bfe7c3ab46ee9c659c1` 6/6 PASS. No skips.
- A second actual SQLite fixture showed complete previous commit prefix 8272 bytes vs full WAL 16512 bytes, coherent mxFrame=4, nBackfill=0; initial fix accepted the shortened valid prefix and SQLite quick_check=ok with the later UNKNOWN absent. The expanded patch fixes that positive contradiction, allowing the inverse legitimate WAL-ahead-of-index case.
- Local exact final candidate blobs `e2ec2c808e128a1d4a7b11f88c61abb69a055b45` (source) and `7ab5780e65995842126fc04e8cd96c67aa990592` (test) passed **10/10**, zero fail/skip/cancel/todo, using Node v22.16.0 and TypeScript transpilation. This is targeted local execution, not whole-repository typecheck or Windows proof.

## Split-header follow-up, 2026-11-24
- Local independent reproduction using source blob `e2ec2c808e128a1d4a7b11f88c61abb69a055b45`, verified via git hash-object. Two authentic SQLite-generated prior/current headers from the same generation were combined in a disposable SHM snapshot, in both copy orders. Shortened WAL retaining only the earlier complete commit: SQLite quick_check=ok, later UNKNOWN absent; validator incorrectly accepted. Intact full WAL accepted in both orders. Baseline 2 PASS / 2 FAIL, zero skip.
- Source blob `7c6d705619cc4f6d510182cb602904830f8c452b` now validates each header independently, rejects positive same-generation contradictions, and keeps strict dual-copy corroboration for frameless/reused WALs unchanged. Test blob `235150296f55d11c4dfff3155b3783f667f41195` adds four cases. Exact local Git-hash readback of both files and existing WAL recycle suite `260997887b42ebcd23860837704d6c3fdee48c06`: 26/26 PASS (14 new-file cases, 12 existing-file cases), 0 fail/cancel/skip/todo. Node v22.16.0, local TypeScript 5.8.3 transpileModule ES2022/ESNext. Targeted strict TypeScript check with noUncheckedIndexedAccess and local @types/node 25.1.0 PASS on the two changed TS files; whole-repository CI separate.
- This is a source-only correction for positive conflicting index evidence, not proof that an untrusted index authenticates a full WAL or that all SQLite rollback cases are detectable. Test data are isolated generated DBs; no real journal modification.
- AI-08 Windows exact-blob acceptance now requires 14/14 in this file and 3/3 in the separate #1245 file per Node22/24. Previous ten-case pins and earlier CI are historical. AI-09 actual packaged/reboot/recycle/permission acceptance NOT_RUN.
