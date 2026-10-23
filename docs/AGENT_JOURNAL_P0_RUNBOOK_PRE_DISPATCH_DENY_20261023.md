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

## Second round: why four legacy positive tests are RED (23 October)

Exact parent #826 HEAD `f9411fb09633c139920e7166c0901b85fdf3e9e2`,
workflow `39862856414` **FAILURE**. Node24 breaks exactly four
unchanged positive runbook tests (Node22 CANCELLED). All five original
#01 deny-path source tests PASS. This is a deliberate compatibility
blocker, not a production-ready result.

| Existing positive | Nested real task graph | Safety classification |
| --- | --- | --- |
| `test/runbooks.test.ts` dependency-aware build/verify | `echo build` via shell; separate verification assertions | Shell command execution, not a proven read-only capability |
| `test/runbooks.test.ts` unknown task graph retry | `echo build` shell, then `retry_unknown:true` expects second shell callback | Blind mutation replay risk from UNKNOWN; must remain RED |
| `test/private-runbook.test.ts` private desktop | `echo private` shell command with desktop routing | Private desktop is not signed native dispatch admission |
| `test/private-runbook-default-policy.test.ts` explicit headless override | `echo hello` shell command | Headless configuration is not remote mutation authority |

Source evidence: `src/agent/executors.ts::runTaskGraph` parses
`TaskGraphJobSchema` which requires arbitrary `command` and executes
that command through `runProcess` or `runWindowsPrivateShell`.
There is NO restricted read-only task-graph execution mode, and a
string that appears innocuous is not proof of no OS side effect.
`src/protocol/capabilities.ts` explicitly excludes `task.graph.run`
and `shell.exec` from READ_ONLY_CAPABILITIES, while
`verify.assertions` is included. A local/mock callback cannot attest
the installed HIGH Broker or external CAS.

**Decision:** do NOT bypass the source gate for any task_graph or
modify legacy tests to expect invented approvals. The existing
`assertions` path is the only currently supported read-only
runbook step. New tests verify assertion-only UNKNOWN resume succeeds,
independent assertions in mixed runbooks still execute, assertions
dependent on denied graph are blocked, and benign-looking shell
commands always remain RECONCILE_REQUIRED. Mixed graph retry does not
erase UNKNOWN. No production code changes in this round, only own QA
and this review ledger. These added tests CANNOT turn the historical
four shell-positive tests green. PR #826 stays DRAFT and CI RED
unless an approved separately operated rollback-independent remote
admission provider and a reviewed compatibility strategy are supplied.

Independent #18 hostile #781 remains byte-identical; its old-SHA
reproduction should be interpreted as UNSAFE, and a changed outcome
against #826 would be evidence of fail-closed denial, not a proof
of physical exactly-once. #587 P0 OPEN; production NO-GO.

## Third round (#01 2026-10-23): direct task.graph.run admission bypass

A separate factual route exists in `src/agent/executors.ts`:
`executeCapability('task.graph.run') -> runTaskGraph -> TaskGraphStore.prepare
-> runProcess/runWindowsPrivateShell`. It never reaches
`executeDurableRunbook` and previously bypassed #826's guard.
`TaskGraphJobSchema` accepts arbitrary `jobs[].command`, so none of
these jobs is an authenticated READ_ONLY capability.

This delegated #01-owned **single executor seam** is now guarded
after schema/dependency/resume validation and BEFORE any
`TaskGraphStore.prepare` or OS process. It calls the same
`assertExternalNativeTaskGraphAdmission()` from #01
`src/agent/runbooks.ts`. With no independently verified off-host
CAS/installed protected HIGH Broker, the function always throws
`RECONCILE_REQUIRED` and accepts no supplied bypass token or mock.
No #31 Git workspace executor-owned code was edited. Existing
runbook task_graph denial remains unchanged. `task.graph.get` and
`task.graph.list` read-only operations remain available.

The original immutable logicalMutationId, requestId, fingerprint,
sourceSha, worktreeId and current ownerEpoch cannot be authenticated
at this direct runtime entrypoint. It is precisely **because** this
verified binding is missing that denial is unconditional. A local
TaskGraphStore ID, replayed signed grant or arbitrary JSON metadata
is NOT remote dispatch admission. This source-only change does not
implement or deploy #587 atomic commitIfCurrent or physical native
cancellation.

New source test `test/agent-direct-task-graph-admission.test.ts`
runs actual executeCapability on disposable TEMP graph state, verifying
direct/clone shell requests never create a file or graph, retry_unknown
doesn't overwrite existing UNKNOWN/runCount, `task.graph.get`
remains read-only, and innocent-looking shell commands are denied.
No remote host, real Broker, D1, UAC/ACL, VM or user files are touched.

Original #781 cloned UNKNOWN negative remains byte-identical, original
four positive runbook tests remain RED, and existing direct-task-graph
positive tests may now be RED as a documented deliberate
compatibility limitation. No greenwashing or always-true CAS.
Coordinate #06/#25 for independent direct-entrypoint negative QA.
P0 #587 remains OPEN; production NO-GO.
