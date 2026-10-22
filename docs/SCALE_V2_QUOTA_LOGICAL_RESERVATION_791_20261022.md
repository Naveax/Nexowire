# Nexowire #14 | #791 logical mutation reservation admission
Date: 22 October 2026. Source/staging only; production **NO-GO**.

## Exact independent ground truth

- Quota #718 parent exact HEAD `3bb5c880e564336fe829d450ce1df7e310935fc5`: Actions `39823756937` **SUCCESS**.
- #791 exact HEAD `22eec6de24264ed1b8a70f5dfbf4bd5375c3ae39`: Actions `39821808832` **FAILURE**, Windows `browser-live` Physical Windows Job Object regression only, other six jobs SUCCESS. Original unmodified `test/worker30-runbook-clone-unknown-staging-fairness-negative.test.ts` executed **1/1 PASS**, but this is an **EXPECTED UNSAFE NEGATIVE**: runbook cloned after lost ACK; two distinct session/root IDs acquire two separate PENDING staging reservations, one CANCEL_PENDING, while quiet tenant retains a share. No original test changes.
- #781 original hostile test independently proved the same logical Native effect can be **re-dispatched** under a different runbook ID with no authoritative owner readback. Quota admission does not stop the agent callback by itself.

## Genuine #14-owned boundary and narrow staging guard

`StagingArtifactByteBudget.begin()` previously indexed reservation by only `sessionId` / `rootInvocationId`. A cloned runbook generates new keys and bypasses local idempotency.

Added **opt-in strict constructor mode** (`requireLogicalAdmission=true`) that refuses legacy `begin` (`LOGICAL_ADMISSION_REQUIRED`). The new `beginForLogicalMutation(x,authority)` method:
1. Requires an INJECTED **current owner + rollback-independent external logical mutation CAS lease**. Missing authority rejects **before any reservation** (`LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED`), never assumes one was installed.
2. Validates trusted server-loaded `logicalOperationId`, `logicalMutationSha256`, original runbook, session/root, owner/device/project, owner epoch and grant generation against a protected witness. `MUTATION_UNKNOWN`, `DISPATCHED`, stale/foreign/missing proof fails closed (`LOGICAL_ADMISSION_RECONCILE_REQUIRED`).
3. In one existing SQLite `BEGIN IMMEDIATE` transaction, checks durable *canonical* binding, reserves session capacity, and inserts logical identity, with a persistent unique key for both logical ID and canonical semantic digest under owner/project. This tombstone is deliberately retained after CANCEL_PENDING or eventual RELEASED. Replaying same session/root while OPEN may return `ALREADY_RESERVED`, cloned IDs / origin roots / semantic aliases cannot mint another reservation on that **same SQLite ledger**.
4. Maintains `stageChunk` PENDING, `requestCancel` tombstones, minute byte accounting, strict-share capacity and all previous deletion restrictions. No minute traffic credit is refunded.

A standalone adversarial QA in `test/scale-v2-artifact-logical-reservation-admission.test.ts` verifies missing CAS, strict-mode legacy rejection, cloned session/root/new logical ID preserving same digest, stale owner/foreign witness/UNKNOWN, idempotency vs CANCEL_PENDING, two Hub-like SQLite handles, noisy owner cap and quiet tenant capacity.

**Critical negative included:** two *disconnected* SQLite ledgers with synthetic fake `NEVER_DISPATCHED` witnesses each reserve the same canonical mutation. This is an **intentional proof that this source-only guard is NOT global/off-host CAS**. The test oracle is only a mock. A real protected service must coordinate current canonical identity+owner epoch, reject clone aliases and hold exclusivity across the SQLite transaction, with shared durable quota storage. No production integration currently uses this new strict method. Legacy `begin()` remains for existing staging tests and is **unsafe for P1 agent admission** unless strict mode is wired and enforced.

## Integration/owner handoff

- **#01 / #780 runbook owner:** fix actual `executeDurableRunbook` classification/re-dispatch of `MUTATION_STATE_UNKNOWN`; require immutable canonical logical mutation ID independent of runbook name, current owner/CAS and reconciliation-before-retry, and wire the protected strict reservation API. NO auto-replay on missing ACK.
- **#08 / #587 external authority owner:** provide genuine anti-alias owner/epoch/issuer proof and monotonic CAS across Hubs, durable writer-stop/deletion and atomic publication state; the mock interface is not evidence of deployment.
- **#14:** strict admission is local staging-only, separately from #718 trusted cleanup after authenticated physical stop/deletion/external CAS. Existing unresolved reservations and consumed minute bytes never disappear. Future per-task steps/time/IO/token budget ledger remains a separate #780 P1 feature.

No live D1/billing/Agent/VM, Native physical I/O, 1 GiB transfer, production enrollment, deployment, or user file modification. Free plan limit and billing OFF unchanged; keep PR DRAFT.
