# NEXOWIRE #06: deterministic reconnect epoch witness and #667 lost ACK acceptance

2026-10-21. **Connection-only source test, production BLOCKED.**

## Exact provenance and CI triage

- Parent **#666** HEAD `748dc6e4e7611b0cbee0d98d5bf7bb728ddd9dc9`; run `39631675531` overall **FAILURE**, because `macos-agent-lifecycle-live` **CANCELLED**. Six other jobs, including Node 22/24, browser-live, Linux native, WSL2 and security-operational, **SUCCESS**. Cancelled is not a failing macOS test, but is also not successful. Cancelled job's archived log could not be read (blob 404).
- **#613** HEAD `b3e3b7bcd6e73a52c0974fe792898d59c2c269cd` and source-only base remains separate; no real external CAS/Native attestation from this PR.
- **#667** DRAFT HEAD `8cbf5c06dfe7677e38f896f90a8dac63eae04458`; exact CI `39631999739` overall **FAILURE** due **browser-live**, while six other jobs, including Node 22/24 and macOS, **SUCCESS**. This branch owns Artifact writer/cancellation implementation; no ownership overlap here.
- The #666 child PR should not be called overall green. This follow-up gets a new isolated branch and new exact-head CI.

## Connection-only source addition

`src/mcp/cross-device-worker-journal-link.ts` extends the read-only #666 worker ↔ checkpoint verifier with a required **`ConnectionSessionWitness`**. Its `currentEpoch(authenticatedRoute)` MUST be served by the trusted current Broker exact-device session registry, not by a client, worker, signed-looking Agent ACK or preference badge.

The verifier requires the current Broker epoch equals the authenticated route AND checkpoint epoch **before stage readback**; it re-reads Broker epoch **after awaited stage readback**, following the existing second CORE/ROOT grant and independent #616 worker lease checks. Thus an otherwise matching old-socket UUID/offset/SHA cannot authenticate a mutation during an intervening reconnect. An unavailable witness fails closed. An advanced/foreign socket epoch returns `epoch_stale`. **This does not create a Broker witness in production**.

The three epochs/authorities are independent:
1. Broker authenticated destination WSS connection epoch;
2. external monotonic worker writer lease epoch/token, as in #616/#634;
3. immutable owner grant epoch and (if ROOT) independent ROOT session generation/15-minute expiry.

This read-only adapter can return `readback_verified_not_committed`, **never** advance #08's worker receipt or #613's Connection checkpoint, start/republish a file, or assert OS side effects. UNKNOWN is not replayable. Any actual reconnect/pair CAS must be done by the authenticated owners outside this adapter.

## Deterministic negative tests

`test/cross-device-worker-journal-link.test.ts` now contains 15 tests including five new **explicit Promise-gated** scenarios; no arbitrary sleep or timing race:

1. Hold correct chunk readback, change Broker epoch 5 → 6, release barrier: `epoch_stale`, zero commit/replay.
2. Trust-owned checkpoint epoch 6 after synthetic re-pair: stale route 5 rejected; new route 6 only `readback_verified_not_committed`, original pending UUID retained.
3. Revoke CORE grant or ROOT session generation while readback is paused: `authority_blocked` even with otherwise valid bytes.
4. Model #667 Native lost ACK and cancellation: `MUTATION_UNKNOWN`, `CANCEL_REQUESTED` or mistakenly downgraded `CANCELLED` with retained pending cannot yield safe completion, mutation repeat or stage cleanup.
5. Missing/contradictory/unreachable Broker session epoch and foreign device: deny.

## Observed tests and limits

- New exact source worktree: typecheck and build **PASS**; 15/15 worker-checkpoint tests and **147/147** selected Connection/Journal/Artifact regressions PASS across 23 test modules.
- Disposable #667 HEAD `8cbf5c0` overlay of Connection sources: typecheck and build **PASS**, **52/53** joint selected tests PASS; failed **inherited #08 test** `test/artifact-writer-fence-221k.test.ts`: `lost ACK after durable first chunk requires explicit resume` ended `Fixture terminal state never reached, expected=COMPLETED`. No production source or test was skipped/modified. Standalone re-run of the same #08 test file **7/7 PASS**, so it is scheduling-sensitive or intermittent in this environment, not demonstrably fixed. Red combined run and #667 hosted browser-live failure remain valid.
- Fixture uses synthetic authenticated route/lease/owner grant objects and in-memory test buffers, not actual Native attested Windows side effects, real external PostgreSQL CAS or signed Broker. No production deployment or actual device restart.

## Owner interfaces and no-go

#08 retains all ownership of `src/mcp/cross-device-transfer-jobs.ts`, Artifact Bridge store, writer cancellation, durable worker receipts and publication. #06 only added the current Broker-session witness requirement to a **read-only** source adapter.

Before production acceptance, #08/#00 must source `ConnectionSessionWitness.currentEpoch` from an independently authenticated exact-device Broker; perform one authoritative checkpoint/receipt CAS; protect against owner revoke during dispatch, late ACK on old socket, rollback/re-pair, physical postcondition and cancel with pending Native write. #667 and #634 need exact-head CI review, including browser-live and deterministic pre-/post-dispatch cancellation regressions. Agent 1.0.5 has no signed atomic Native fenced writer; physical transfer remains NO-GO.

No #08 store/worker/Agent files touched, no VM, UAC, live privileged calls, physical Agent disconnect or user files modified.
