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
