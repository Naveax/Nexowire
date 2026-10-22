# #01 P0 #587 / P1 #780 runbook fail-closed pre-dispatch source boundary
Date: 23 October 2026.

## Observed defect, verified before code

Independent #18 QA PR #781 HEAD `89a865363829c8c30a74de1516e53a697549c05b`,
exact CI `39816363122` 7/7 SUCCESS reproduced an UNSAFE SOURCE
NEGATIVE: `executeDurableRunbook` previously marked
`MUTATION_STATE_UNKNOWN` as `failed`, and a cloned runbook_id made a
new graph_id and called a synthetic mutation a second time. The
independent QA test is byte-identical and intentionally expects the
old UNSAFE behavior. Its failure against this branch would represent
the defect no longer reproducing, not weakening original QA.

## Actual source code boundary

`src/agent/runbooks.ts` now denies every `task_graph` dispatch
before invoking `callbacks.runTaskGraph`, with error code
`RECONCILE_REQUIRED`, persisted as step `unknown` and runbook
`interrupted`. For resume with retry_unknown or retry_failed, it denies
BEFORE `RunbookStore.prepare`, preserving an original
`MUTATION_STATE_UNKNOWN` errorCode and run count. The only permitted
runbook steps are pure `assertions` (separate, non-native callback).
This is a deliberate availability reduction and may turn pre-existing
positive execution tests RED. Never misrepresent legacy test failures
as a functional green rollout.

The existing runtime **does not** expose a verified off-host CAS
admission interface or original `logicalMutationId`, `requestId`,
`fingerprint`, `sourceSha`, `worktreeId` and independent current owner
epoch at the actual callback boundary. Those typed source fields in
#783 are advisory only. No supplied boolean, local mock, in-process
lock, UI preference or old signed grant can authorize native effect.
Therefore there is NO bypass/allow path and NO native dispatch in
this branch. The earlier security-blocked #712 atomic external CAS
patch was not retried.

## Admission provider handoff (BLOCKED)

A separately operated rollback-independent monotonic service must
atomically implement `reserveIfCurrent -> commitIfCurrent` ordered
with revoke-start, bind immutable original mutation identity and
source/worktree/owner scope, and produce signed current Broker
admission. A lost OS ACK MUST remain UNKNOWN; reconciliation is
read-only and does not replay. The installed HIGH Broker and native
postcondition require independent physical attestation. This source
branch does not implement, deploy, or test any of those capabilities.

## Minimal source regression expectations

`test/agent-runbook-unknown-source-guard.test.ts` calls the **actual**
`executeDurableRunbook` with disposable TEMP JSON and callback
counters, proving zero synthetic effects on first or cloned runbook,
UNKNOWN checkpoint with RECONCILE_REQUIRED, retry_unknown/retry_failed
cannot erase original evidence, and assertions remain available.

No #18 test, #03 Broker, #04 Access, #08 checkpoint, live Agent 1.0.5,
D1, UAC, ACL, VM, user workspace or ReVoltVPN-Ubuntu-Lab was changed.

**Production NO-GO; P0 #587 OPEN. Source CI is not physical proof.**
