# Worker #30 | #780 per-task worker budgets + deterministic tiny/UNKNOWN QA

**Date: 2026-10-22.** Independent source-only DRAFT, no deployed agent loop, no physical admission. Scope: #780 P1 self-host first. Parent #774 HEAD `5e432c26072d82e89069fc702e634a80d2d02534`, exact CI `39806480924` SUCCESS.

## Existing inventory: do not duplicate

- `src/agent/task-graph-store.ts` has payload-free durable task-graph checkpoints, up to 32 jobs/graph, persisted job state `unknown` on interrupted running jobs, replay controls `retryUnknown`, and no authenticated per-task steps/tokens/memory/transfer budget or physical stop/delete gate. The mere availability of `retryUnknown` must not become automatic Native mutation replay. #780 has P1 opt-in loop acceptance but is currently a product *issue*, not a PR with a completed worker.
- `src/ops/scale-s5-protected-admission.ts` is actual test/staging-only strict non-work-conserving per-tenant SQLite admission. It does not authenticate principals, authorize execution or provide tenant-native memory budgeting.
- `src/ops/scale-v2-artifact-byte-budget-staging.ts` has real *staging* SQLite PENDING chunk and reserved storage accounting. It is not physically integrated into self-host worker lifecycle or #718 external protected cleanup.
- #738 HEAD `ce85d257c2f005156175a4d14a65ec81565575fc`, hosted `39677587592` SUCCESS: real #598 parser, four gzip requests each **9,961,472 decompressed JSON bytes** with **64 small identity** requests. Node22 tiny N=64 p95/p99 **181.198/188.449ms**, large N=4 **1041.139/1041.139ms**; Node24 tiny **192.087/194.717ms**, large **958.405/958.405ms**. From `performance.now()`, beginning of request to consumed response JSON, nearest-rank `ceil(p×N)-1`. Seed `0x5a17c0de` fixes the input, **not timing**. No new parser load or p95/p99 manufactured here.
- #774 HEAD `5e432c26072d82e89069fc702e634a80d2d02534`, `39806480924` SUCCESS: #768 monotonic final *publication* is NOT trusted writer-stop/deletion, source UNKNOWN preserves quota. Existing tests already prove late publish ACK/cancel/re-pair and staging no refund. This child does not duplicate #774 or modify any P0 authority source.
- #718 quota owner branch still handles external CAS/cleanup and is **not** a deployed integration into this P1 task. A source-only simulator cannot attest OS isolation or paid entitlement.

## Proposed P1 worker acceptance contract (not deployed defaults)

Recommended starting **per-task opt-in configurable maximums** (subject to owner/source review): 24 plan/tool steps, 15 minutes wall clock (using monotonic deadline; bounded individual tool timeouts), 32,000 combined model tokens, 128 MiB **in-flight task-reserved** application memory, 64 MiB **cumulative staged or transferred bytes**. Put an explicit tenant-level outer budget and max two worker slots/tenant around these; the outer limit must not expand when a task changes `requestId` or splits into subagents. Values are **design proposals**, not existing Nexowire settings, benchmark capacity, physical OS enforcement or paid product quota.

Authority contract:
1. Before a step, atomically reserve stable `ownerId/deviceId/taskId/ownerEpoch/requestId/specSHA` with task and tenant ceilings; charge tokens/time/steps and memory/IO reservations conservatively. On ambiguity, classify `MUTATION_UNKNOWN` and `RECONCILE_REQUIRED`; no auto replay, new requestId clone, checkpoint reset or early counter refund.
2. **Steps and used model tokens are usage**, so never refund because of cancellation. Uploaded/transferred byte accounting remains billed/consumed as designed even if stage deleted. **In-flight memory and disk-space reservations** may be freed only after authenticated independently scoped **writer-stop plus actual deletion/readback** with current epoch and rollback-independent authority. Final publication commit alone cannot prove cleanup.
3. Read-only short jobs may release ephemeral memory on authentic local completion, but cannot borrow reserved Native task slots or drain another tenant's strict share. A client-provided tenant header, progress PID or stale checkpoint SHA cannot authorize work.
4. Exhausting steps/time/tokens while side effects remain UNKNOWN halts worker and retains reservations. Restart/re-pair must prove new grant+ownerEpoch and prior immutable effect status before continuing. Enforce true memory/process/network isolation separately by OS sandbox with measured admission; a JS counter is only a reference model.

## Only missing joint source QA (two focused negatives)

`test/worker30-p1-loop-task-budget-fairness-unknown.test.ts` uses real `ProposedS5ProtectedTenantAdmission` and real `StagingArtifactByteBudget` SQLite plus an explicitly named **TEST-ONLY task budget fence** with strict, small synthetic limits: 16 steps / 60 sec / 64 tokens / 128 KiB memory / 128 KiB transfer.

- **Seed `0x30ca5e21`**, 64 logical small jobs shuffled reproducibly: 48 noisy across 3 tasks and 16 quiet in one task. 32/min outer strict share (16/16) produces exactly **16 noisy accept, 16 quiet accept, 32 noisy deny**, irrespective of cross-task noisy fan-out. The model treats source `authorizesToolExecution:false` correctly. This is not 64 physical HTTP requests, does not report new measured latency and makes no WSS concurrency claim.
- **Native UNKNOWN seam:** actual staging creates owner A and owner B sessions, one real SQLite PENDING 65,536-byte A chunk, `requestCancel` remains pending. Reference budget marks the Native effect UNKNOWN and requires RECONCILE; exact requestId duplicate is not replayed; forged writer-stop/deleted booleans and stale owner epoch after re-pair cannot free A's memory/transfer debit. A's other task fills the remaining cap and further resource reservation is rejected; independent B read-only job still succeeds. Real SQLite holds PENDING=1 and file reservation=262,144 bytes.
- **Dimension gates**: test explicitly rejects excess token usage, step count, monotonic logical deadline, owner memory and transfer byte reservations. Read-only completed requests use **zero Native resource reservation** and may finish normally. This does not imply real OS memory enforcement, native side effects, or a secure external witness.
- CI marker `QA30_P1_FAIRNESS` for counts and `QA30_P1_UNKNOWN_BUDGET` for rejection provenance. No p95/p99 generated from instant SQLite decisions or deterministic clock; only #738 **previous actual localhost** p95/p99 is cited.

## Reproduction, CI boundaries and physical NO-GO

```sh
node --test --import tsx test/worker30-p1-loop-task-budget-fairness-unknown.test.ts
npm run typecheck
```

A new exact HEAD and workflow must be checked independently. GitHub PR checkout `GITHUB_SHA` may be a temporary merge SHA and must not be represented as branch tip. Do not mute inherited Windows regressions or artificially declare source green without test logs.

**NOT TESTED**: authenticated physical public 101+ native WSS, 1GiB native file/actual disk verification, independent Native signed writer-stop/deletion, protected OS sandbox/Job/ACL/AppContainer, worker tokens/usage from actual provider, real 24h stress, paid Cloudflare/D1/Billing, any live Agent/VM/UAC/Broker. Physical admission **NO-GO**.

This change adds **only one new QA test and this report**, and does not mutate existing parser/fairness code, P0 Artifact, quota owner code, installed Agent, task-graph production or CI workflows.
