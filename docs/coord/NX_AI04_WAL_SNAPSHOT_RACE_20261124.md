# AI-04 — ordinary WAL-index metadata race (2026-11-24)

## Exact failing source and prior green evidence

AI-07 Draft #1284 `7bcf049fa40b0e239e42ad817c4a6441703d6486`, General CI 45411544958, Node22 job 138506372041, 14:14:32 UTC. The existing third actual-child-owner test expected AGENT_JOURNAL_IN_USE; actual AGENT_JOURNAL_WAL_CORRUPT. Stack: assertStablePath:57 -> readIndexSnapshot:96 -> rejectContradictoryCommitIndex:146 -> verifyAgentJournalWal:374 -> initializeUncontended:180. This proves the ordinary SHM pathname/metadata stability guard failed before SQLite ownership/OS incarnation readback; the old log does not identify the mismatched field. No positive frame checksum or commit contradiction was logged. Node24 cancelled. Last accepted #1160 `e3436d671bcf1944144246edabf2d7998e9dfc53`, CI 45399447087, Node22 138463874684 (actual child test PASS), Node24 138463874579 SUCCESS. Journal source and relevant test blobs identical across green base, #1283 parent and failing #1284:
- operation-journal.ts 598882cf2a47c764a4e4d8b111228f60460fad1f
- operation-journal-wal.ts 7c6d705619cc4f6d510182cb602904830f8c452b
- journal-owner-process.ts cabe4f51203c7c93b94640f5c3e0b19f516b7e5a
- operation-journal-authority.ts b98e8a6f12ce740bfe7ddea3d6aa2561edde2575
- external-owner test 9d2daca025c666ab7be8b250481519f0bd1bffae
- frameless-WAL test 235150296f55d11c4dfff3155b3783f667f41195

#1284 adds two transfer-authority paths only. No evidence of an AI-07 journal-source regression.

## Fail-closed correction and limits

For an ordinary fully checksummed committed WAL (no frameless/reused tail), distinguish same regular-file dev/ino/size timestamp drift in the SHM observation from structural/checksum/identity/size/path contradictions. Close handles and restart the entire read-only WAL validation from byte zero at most twice (10/25 ms backoffs). A successful fresh stable scan is required before SQLite open/lease checks. After three unstable observations throw AGENT_JOURNAL_WAL_UNSTABLE (not IN_USE or success); actual corruption checks still fail immediately. Frameless and old-generation reuse paths remain strict and unchanged. No metadata drift is treated as proof of owner liveness. Only existing PID/incarnation + BEGIN IMMEDIATE transaction determines IN_USE; after verified death UNKNOWN remains sticky. Native singleton and independent authority remain mandatory, and this retry does not provide an atomic preflight/open boundary or authenticate rollback. New error is a distinct runtime code; the existing startup diagnostic allowlist will conservatively report generic initialization failure until its owner explicitly reviews a new diagnostic enum. No shared workflow or diagnostic file change.

## Independent regression

`test/agent/ai04-wal-snapshot-race.test.ts` creates authentic SQLite WAL/SHM fixtures. A deterministic test fault injects real timestamp-only drift at the same lstat-after-fstat edge (not a forged error or relaxed assertion). Seven tests require:
- one transient drift: stable complete scan, unchanged bytes;
- continuous drift: bounded UNSTABLE, unchanged bytes;
- prior valid commit prefix contradicted by retained index: CORRUPT after fresh scan;
- new checksum damage during retry: CORRUPT before index read;
- frameless and RESTART old-generation index instability: CORRUPT, no retry;
- genuine independent child owner: exact IN_USE after full revalidation, no owner-row/reservation change; positive death -> UNKNOWN, no replay, wrong fingerprint denied.

Run the new file explicitly, plus unchanged external-owner (3), frameless (14), root journal/WAL/restart/recycle tests. Node22/24 Linux and hosted Windows, exact SHA, zero new-test skips. AI-08 owns independent Windows fixture selection/provenance. No physical acceptance claimed. #974/#1001 remain open; AI-09 only for signed installed Agent/two reboot/recycles and protected-device acceptance. Do not change #1284, #1160 or prior protected branches. Roll back only this isolated source follow-up if rejected.
