# Worker #39 | independent multitenant admission / fairness source QA

Date: 2026-10-23. Coordination: #539, epic #780.
**DRAFT / SOURCE ONLY / PRODUCTION NO-GO.** No external CAS witness, Native Agent, Broker, Cloudflare D1, billing, VM or physical worker is introduced.

## Live source baseline (verified before creating this branch)

- #718 exact source HEAD `20ef28fa725f21e9585b73263feef72705c1dedf`, associated Actions `39842175513` SUCCESS.
- #806 exact HEAD `13a6fb38cddde635c71ca0f023b763c8f68534c6`, Actions `39841477982` FAILURE. Its unchanged #791 compatibility test is still an expected-red integration signal, not proof of safe dispatch.
- #791 exact HEAD `22eec6de24264ed1b8a70f5dfbf4bd5375c3ae39`, Actions `39821808832` FAILURE.
- This QA branch is stacked solely on #718; prior #791/#806 files remain byte-for-byte unchanged.
- #718 staging `StagingArtifactByteBudget.beginForLogicalMutation` is real code, but **has no deployed off-host CAS authority**. Its strict mode denies unsafe legacy `begin`; missing authority denies all logical reservation before any SQLite write. Its semantic unique index protects a **single shared local SQLite file only**.
- Actual `executeDurableRunbook` is still independently dispatchable with a cloned `runbook_id` after `MUTATION_STATE_UNKNOWN`; quota admission does not intercept this callback path.
- #33 proposed `src/coding/task-loop-engine` was not present as a verified callable source API at inspection. Do not fabricate its interface or tests that pass using a test-only fake worker.

## Independent QA contract in `test/worker39-multitenant-admission-loop-source.test.ts`

1. **Fail-closed real quota without trusted CAS**: original Tenant A logical mutation, cloned session/root/runbook, owner epoch drift, and grant-generation drift all reject before physical or SQLite reservation. This establishes only missing-provider denial; it does **not** claim independently tested owner-epoch matching against a real provider.
2. **Tenant B fairness under noisy Tenant A**: fixed-seed 32-attempt schedule (24 A / 8 B), real S5 strict-share SQLite allocator, expected A 8 accepted and 16 exhausted, all eight B requests accepted. Each B request executes only an in-process **read-only assertions** runbook. `authorizesToolExecution` remains false. Completion is bounded by at most 32 deterministic admission events, **not** measured physical worker latency or #33 loop steps.
3. **Intentional RED required invariant**: after real `executeDurableRunbook` receives a synthetic lost-ACK `MUTATION_STATE_UNKNOWN` from a pure counter callback, cloning the runbook ID must **not call the callback a second time**. Current source is expected to make this assertion fail. This differs from #791's PASS-means-unsafe staging ledger negative: this is a positive fail-closed acceptance assertion. There is no Native effect, real OS I/O, or fabricated CAS.

## BLOCKED prerequisites to complete #39 acceptance

| Requirement | Verified integration | Needed owner API or authority |
|---|---|---|
| A cannot reserve twice after UNKNOWN under two independent Hubs | Local strict reservation safe **only when provider supplied**; provider absent => both deny | #01 stable semantic mutation identity, #14 strict quota called at every dispatch and shared durable quota state, independent CAS across Hubs |
| A cannot redispatch on clone or changed session ID | **RED**, direct actual runbook callback still bypasses quota | #01/#33 pre-dispatch immutable logical mutation admission, protected UNKNOWN reconciliation |
| Tenant B eight read-only tasks finish within bounded loop steps | 8 read-only runbook assertions proven under fixed 32-event S5 schedule; #33 loop NOT proven | #33 actual bounded PLAN / TOOL / OBSERVE / TEST / FIX / STOP source and one test-only read-only execution adapter |
| Per-task time/step/token/memory/transfer budget exhaustion | **BLOCKED** for #33; no deployed budget API, and fairness reservation is not task budget | #33 trusted budget ledger with monotonic clock, canonical task owner/device/worktree and deterministic exhaustion result |
| Cancellation and ownerEpoch/grant drift stop execution | Missing CAS rejects quota; **BLOCKED** for actual post-approval dispatch/cancel | #33 immutable owner epoch and signed current grant, cancellation fence and no-dispatch-before-readback |
| UNKNOWN release or cross-Hub replay | **BLOCKED**; local SQLite is not off-host CAS, and no fake provider is installed | Independent protected current CAS/issuer/owner readback, no replay until reconciliation and verified writer stop |

Do **not** interpret any successful S5 allocation as authorization to execute a native tool. Do **not** merge this RED QA on its own; wait for source owners' genuine guards and rerun the existing exact-SHA CI without duplicate workflows. No main merge. No modifications to #14, #01, #33, #791, #806, or original RED suites.


## NEXT2 exact-head cross-review, 2026-10-23 (supersedes older source inventory)

**#817** HEAD `38ae28829a41cf79618266ae7af1852a70cebae5`, Actions `39862408018` completed **FAILURE**:
- Node22 job `120116122159`: first QA39 strict missing-CAS gate PASS; fixed-seed Tenant B 8/8 read-only PASS (32 events; 0 native tool calls); third acceptance test **RED** at `test/worker39-multitenant-admission-loop-source.test.ts:174`: `2 !== 1` callback invocations after cloned `runbook_id` and synthetic lost Native ACK. This is a genuine fail-closed **runbook callback source** gap, not a fixture type/compile error; no physical Native mutation is claimed.
- Node24 job `120116122078`: `npm run check` failed, job reported cancelled; do not call it green. Windows `browser-live` `120116122563`: **FAILURE** at separate Physical Windows Job Object regressions.
- No new test is required to duplicate this observed source gap; preserve existing deliberate RED test unchanged and do not convert its unsafe behavior to an expected PASS.

**#14 / #718** current independent HEAD `d0a9ba925580c44c5f2f48a709fb0b7e968430c1`, Actions `39866600323` completed **FAILURE**, six non-Windows jobs including Node22/24 SUCCESS, Windows Job Object FAILURE. Earlier baseline `20ef28fa...` above was correct only at branch creation and is now **stale**. Current `src/ops/scale-v2-artifact-byte-budget-staging.ts` has the REAL strict API
`StagingArtifactByteBudget.beginForLogicalMutation(binding, authority?)`.
It is **not an integrated runner**. Constructor `requireLogicalAdmission=true` denies old `begin` with `LOGICAL_ADMISSION_REQUIRED`. Missing `authority.withCurrentLogicalAdmission` denies before SQLite reservation with `LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED`. The source validates immutable owner/device/project/session/root, originRunbookId, logicalOperationId, logicalMutationSha256, ownerEpoch, grantGeneration, and `NEVER_DISPATCHED`. Local transactional identity replay also compares persisted device, origin runbook, owner epoch and grant generation, preventing same-ledger alias. Different disconnected SQLite files remain unsafe without independent off-host monotonic authority. The authority interface is an injection seam, not a deployed signer/CAS.

**#33 / #822** now exists: HEAD `4937d3febc2d9ccfa5749893461615fd8ffbe9b5`, Actions `39862713170` completed **FAILURE**, Node22/24 SUCCESS, Windows Job Object FAILURE. Actual exported APIs: `createTaskLoop(plan, nowMs)`, `advanceTaskLoop(checkpoint, context)`. `src/coding/task-loop-engine.ts` is metadata-only; all actions expose `canExecuteMutation:false`, including `TOOL_INTENT`. Mutation mode returns `RECONCILE_REQUIRED/EXTERNAL_CAS_REQUIRED`; read-only tool intents require a separate trusted executor not present here. `tenantCapacity` in `LoopRuntimeContext` is an input observation, **not** a real admission reservation. Checkpoint budgets cover maxActions/maxFixes/maxTokens/timeoutMs, **not** measured worker memory/transfer or a physical per-tenant scheduler.

### Exact cross-owner integration contract needed before adding #39 positive integrated acceptance

1. **#01 owner / runbook:** deliver a protected, immutable `logicalMutationId` and original `requestId` bound to owner/device/project/originRunbookId/ownerEpoch/grantGeneration/worktree/source SHA. A newly supplied `runbook_id`, task, session or root MUST NOT mint a different semantic identity for the same pending native effect. Lost ACK must persist `UNKNOWN`, never convert to retryable `FAILED`.
2. **#33 loop owner:** create a real, current, trusted transition from `LoopIdentity` to a server-bound task admission request (NOT a client-derived mapping). `LoopIdentity` has `tenantId/taskId/worktreeId/logicalMutationId/originalRequestId/taskSha/worktreeSha/sourceSha/ownerEpoch/grant.generation`, while #14 requires `ownerId/deviceId/projectId/sessionId/rootInvocationId/originRunbookId/logicalOperationId/logicalMutationSha256/ownerEpoch/grantGeneration`. **Device/project/physical session/origin runbook are not present in #33 identity**; no valid source-backed equivalence currently exists. `taskSha` / `worktreeSha` are not a trusted canonical `logicalMutationSha256` merely because both look like hashes.
3. **#14 quota owner + #08/#587 provider:** expose an authenticated rollback-independent, held-CAS lease that resolves those principal and canonical identities and supplies current `NEVER_DISPATCHED` / `MUTATION_UNKNOWN` / `DISPATCHED`; check all aliases and owner generation within a shared durable admission transaction before permitting **any** effect. Bind quota admission, runbook callback and worker dispatch; no independent local SQLite or fake proof may return a dispatch grant.
4. **#33 executor owner:** a truly read-only worker step may only execute after separate trusted authorization; task limit, cancellation, revocation and epoch drift must be rechecked at the physical dispatch boundary. PENDING / UNKNOWN retains reservation and forces reconciliation; full token, step, time, memory, transfer and cancellation conditions must fail closed. S5 `FairDecision.authorizesToolExecution:false` must never turn into a native capability.
5. **#39 acceptance when (and only when) APIs are wired:** deterministic mixed A/B 32-event test with A's lost-ACK effect held `UNKNOWN`; cloned A IDs always yield zero **new** quota reservations and zero **new** native-effect invocations; B completes 8/8 independently with actual trusted read-only executor/tenant admission within declared bounded actions; cancellation/epoch/budget negatives deny with unchanged durable state across restart and two Hubs. Preserve original #817 RED as a regression rather than suppressing it.

**Current verdict: INTEGRATION BLOCKED, not fixture false positive.** The #718 strict method and #822 metadata loop exist separately, but there is no verified callable cross-module bridge, off-host protected CAS, or native execution grant. No synthetic CAS oracle was added to #39. No owner production files, Agent 1.0.5, D1/billing, Broker/UAC/ACL, user files, VM, or main merge touched. P0 physical production remains **NO-GO**.
