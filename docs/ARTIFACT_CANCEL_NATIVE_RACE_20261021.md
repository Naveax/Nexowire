# #08 P0 cancel/Native mutation ordering acceptance, 21 October 2026

## Provenance

Base: PR #634 HEAD 9266f9b65a1f193360469223360552a50892949a, GH run 39610829832 FAILURE. The failing GitHub Node22 job 119258913381 shows one real error: `test/artifact-588-cross-device.e2e.test.ts:259` "cancel must prevent any publication" while the original 120ms source-read sleep caused nondeterministic order. Node24 was cancelled after the Node22 failure. This is not the unrelated hosted Windows Job fast-exit failure.

Independent QA: PR #640 HEAD 91f1426f5378bc2eaf3a680a7f7e067f8d4eba73, exact five Promise-gated source tests. Copied unchanged to the Work PC isolated test worktree. **BASELINE RED 3/5**: cancel during first source read became MUTATION_UNKNOWN though zero Native writes; cancel after settled unknown side effect incorrectly became CANCELLED. The other 3 cases passed. QA #641 HEAD a6906b4f45c3ba285a733dda689f799e696ec2bf independently supplies 7 two-Hub tests, also used unchanged as temporary test inputs. QA files remain under #21/#22 ownership and are NOT edited or committed here.

## Source fix (owner #08)

Only `src/mcp/cross-device-transfer-jobs.ts` production logic changed. Define durable cancellation settlement based on two independent facts: `bytesConfirmed > 0` or `pending` mutation. A job may enter **CANCELLED** only when both are absent, proving no Native write was committed or reserved for dispatch. Any positive confirmed chunk or unresolved requestId/epoch/offset/sha remains **MUTATION_UNKNOWN**; a later cancellation MUST NOT erase or downgrade the journal. In-flight worker returns and asynchronous catch handlers apply the same monotonic rule. Explicit resume continues only via previously implemented higher external fence and exact source/stage hash, not by replaying pending requests.

Recheck cancellation after source read before dispatch, including the legacy isolated path; no Native write is scheduled after a pre-dispatch cancellation. Repeat at the worker loop boundary and final no-overwrite publish state transition, so cancellation after a verified chunk can never impersonate zero-side-effect cancellation. Already publishing or published destinations remain non-cancellable.

`test/artifact-588-cross-device.e2e.test.ts` replaces the 120ms source-read delay and 160ms finish delay with a strict Promise barrier and persisted journal checks. The cancellation is initiated ONLY AFTER an actual source read enters the barrier. Worker cancellation is acknowledged before that read is released. The journal must end CANCELLED, confirmed bytes zero, no pending request, and no published target file.

## Synthetic tests / real-world boundary

- #640 five independent QA cases preserved intact: **5/5 PASS** after source fix, previous base 3/5 with two real failures.
- #641 seven independent cross-Hub CAS/fencing cases: **7/7 PASS**, no QA child files edited/merged.
- Original MCP two-sandbox WebSocket Agent E2E: PASS with deterministic read barrier and one-call transfer_start/status/cancel.
- **138/138 focused tests PASS** including #640 five and #641 seven original QA cases, original MCP two-Agent E2E, hash, pending journal, owner grants and quota/checkpoint regression. `npm run typecheck`, `npm run build`, `npm run continuation:check` PASS on isolated Work PC worktree. QA child files were fetched unchanged only for testing, not committed to this owner branch. All files tested are synthetic and disposable.
- This is not physical production proof. Real Agent 1.0.5 lacks authenticated Native epoch+offset atomic CAS, and a real #587 external monotonic trust root is absent. #05 Native, #06/#613 connection epoch, #601/#610 quota proof, #16 QA, #00 integrator must pass before production.

No live Agent/Hub restart, signed rollout, production deployment, 1GiB allocation, VM, or user-file deletion/overwrite. DRAFT-only PR; no merge. GitHub exact-head CI state is recorded separately, never inferred from local tests.
