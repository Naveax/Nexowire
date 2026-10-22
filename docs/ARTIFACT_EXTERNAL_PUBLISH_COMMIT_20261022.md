# Nexowire #08: external monotonic publication commit after verified Native receipt

Date: 22 October 2026. Owner-only source follow-up on DRAFT PR #754, exact base HEAD 3a5bf392109d17dbf2650a18398917d5501fd488. GitHub run 39736052869: FAILURE 6/7 PASS, solely Windows browser-live fast-exit stdout/stderr drain test at windows-job-owner.test.ts:216, iteration 6. Node22, Node24, WSL2, macOS, native Linux and security PASSED. This failure is inherited unrelated Windows Job ownership, not a Final Receipt test failure.

## Independent cross-review

- #708 current HEAD 9849b7f122f0842274e4c87bd61dfc1771e05b47, original QA test blob byte-for-byte restored from GitHub into #754 isolated worktree: **22/22 PASS**. Its earlier three obsolete generic-error expectations were already corrected in #22's updated owner QA. No #708 test edits or duplicate cancellation work.
- #752 Connection orphan no-replay HEAD 95bea58abf5be7e0fb4a3c8d7798285423e97573, GitHub run 39735641942 SUCCESS. Separate isolated exact #752 worktree plus #751 original independent external durable owner witness test, copied with matching Git blob, resulted **11/11 PASS** including orphan WAL double reconnect and independent high-water rollback witness.
- #751 HEAD 2530ccaf6baa03596c3b07a5c192510ea4ab4c19 hosted run 39735623362 FAILURE, but its only failed job was Windows browser-live fast-exit stdout drain at iteration 5, not its independent witness test. Current #708 hosted run 39735289407 failed the same Windows Job at iteration 7, with Node22/24 PASS.
- Original #754 signed Native receipt fixture without external final commit only proved a signed-looking publisher proof and post-readback lease checks; neither alone can make a local journal commit atomic with a concurrent offhost owner/epoch revocation.

## Newly proven actual #08 P0 defect (RED baseline)

New deterministic gate in test/artifact-08-final-native-receipt.test.ts revokes independent owner/lease immediately AFTER final successful PUBLISH precheck but BEFORE async local journal update. Exact unchanged #754 completed with state COMPLETED and gave the new case RED: **7 PASS, 1 FAIL**. The problem is time-of-check/time-of-use, not Windows Job or fabricated Native ACK.

## Narrow production fix

- TrustedTransferAuthority now offers optional commitPublished(job, authenticatedFinalReceipt), **MANDATORY on hosted strict final receipt path**. Must be implemented by a rollback-independent monotonic service as one atomic conditional record with current owner/grant/epoch, exact requestId, SHA and independently signed Native publication proof. Missing function causes FINAL publication admission to fail BEFORE any Native mutation. A local WAL or a plain boolean is NOT an implementation.
- After verifying receipt exact job/owner/project/target device/path/requestId/full-file SHA and independent protected signature, then actual destination final stat/hash and fresh CORE/lease, worker requires external commitPublished. Response must bind jobId/requestId/epoch/SHA and a distinct non-empty durableCommitId from that protected service. Invalid, stale or denied commit is MUTATION_UNKNOWN, NOT COMPLETED, while preserving original publication requestId and no blind replay.
- Commit ID and COMPLETED state are persisted together in the one local final journal CAS. If post-external local journal write fails, the worker must conservatively preserve UNKNOWN or pending PUBLISHING and never classify a potentially published object as ordinary FAILED or automatically republish.
- Direct legacy synthetic worker fixtures without requireAuthenticatedFinalReceipt retain test-only behavior. Production Agent 1.0.5 has NO atomic signed Native offset-CAS publisher or protected final commit oracle; therefore hosted strict mode stays fail closed by design.

## Test acceptance

- New RED case becomes GREEN with precise NATIVE_LEASE_EXPIRED, persistent MUTATION_UNKNOWN, no external commit ID; extra wrong-external-commit claim and missing external CAS start-denial scenarios pass.
- Final publication owner test plus original two WebSocket sandbox Agents: **11/11 PASS**. HMAC signer and synthetic in-memory monotonic commit are TEST-ONLY and NOT a physical signing/witness service.
- Full #08 focused cases including #708 original unchanged two-Hub CAS (22 cases), Artifact Store/Bridge, staging quota/checkpoint, CORE grants, original one-call E2E, original forged ACK, cancel/reconnect: **121/121 PASS**. npm run typecheck/build/continuation and whitespace diff checks PASS.
- #751/#752 separate source lineage original independent witness test: **11/11 PASS**, no #06 or #21 code modified.
- No real Agent/Hub/VM restart or 1GiB/physical transfer, no user file mutation, production deploy or main merge.

## Still production NO-GO

#587 rollback-external monotonic CAS + atomic publish commit service not deployed, #05 protected Native signed writer/publisher with 64-bit offsets/strict IO CAS and durable SHA signer unavailable on Agent 1.0.5, #610 immutable quota receipts, #613/#742 owner epoch/nonce/current grant, #16 independent staging and #00 integration. Source acceptance is not physical or production authorization.
