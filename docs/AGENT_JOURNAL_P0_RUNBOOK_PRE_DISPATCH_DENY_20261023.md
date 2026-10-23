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

## Fourth round: exhaustive original Node24 18/18 classification (#01 NEXT4, 2026-10-23)

Exact parent #826 HEAD `aabc75fd539dfb1b5db42d958ba344d12bad4f3c`,
run `39914532851` **FAILURE**; Node24 had 18 unchanged legacy
positives RED and all five new direct-graph deny tests PASS.
Browser-live also FAILURE, Node22 CANCELLED; WSL2/Linux/macOS/security
SUCCESS. PR #847 HEAD `79fdecf348b526c1e876f434d6f0292769b2bc17`
is a hostile QA candidate based on #843/#826 **OLDER**
`5e307dd48657512ed0e5d5b2908e7d2cd93ec6b5`; its RED
is NOT a bypass proof against the newer #826 direct graph guard.
The independent #847 test must remain unchanged.

| # | Original unchanged failing expectation | Genuine trusted-readonly? / reason |
| - | - | - |
| 1 | explicit headless override still wins over configured private default | NO: `echo hello` shell dispatched |
| 2 | private runbook pins every nested task graph to NexowirePrivate and denies headless resume | NO: `echo private` shell dispatched |
| 3 | private task graph refuses unsupported OS without headless fallback | NO: shell entry `echo deny`; OS precheck assertion coupled to dispatch |
| 4 | negative: an artifact changed without changing its byte count must not verify | MIXED: verification is read-only, but test first creates artifact with shell |
| 5 | durable runbook persists dependency-aware task/assertion steps without payloads | MIXED: read-only assertions follow `echo build` shell task |
| 6 | unknown task-graph step requires explicit retry_unknown | UNSAFE: rerun of original `echo build` after UNKNOWN |
| 7 | task graph records verified artifact metadata without persisting artifact content | MIXED: provenance read-only, initial shell produces artifact |
| 8 | task graph fails a job when a declared artifact is missing | NO: requires shell process/job success before artifact failure |
| 9 | task artifact lifecycle lists, re-verifies, detects changes, and detects missing files | MIXED: artifact list/verify read-only, initial shell creates data |
| 10 | task artifact hashing is bounded during collection | MIXED: read-only hashing after shell creates artifact |
| 11 | persisted task graph resume reuses succeeded jobs instead of rerunning them | MIXED: resume-read can reuse, but test first runs shell to establish success |
| 12 | persistent task graph rejects mismatched resume specifications | MIXED: spec comparison read-only, but test first submits shell |
| 13 | unknown post-restart jobs require explicit retry_unknown before replay | UNSAFE: expects explicit shell retry of original UNKNOWN |
| 14 | task graph list/get/prune capabilities expose payload-free metadata | MIXED: list/get readonly, prune deletes checkpoint; test first executes shell |
| 15 | task graph runs independent jobs in parallel and waits for dependencies | NO: several arbitrary shell commands |
| 16 | task graph blocks dependents after failure but lets independent work finish | NO: shell process.exit plus parallel shell |
| 17 | task graph stop_on_failure blocks later independent jobs | NO: shell exit and scheduling |
| 18 | task graph total timeout bounds a long-running job | NO: running shell with timeout |

All 18 complete test workflows therefore require a **mutating/native-capable
shell setup or execution**, even when an intermediate assertion is a
pure read. Passing them by special-casing commands such as `echo`,
`cat` or `node -e console.log` would be a security bypass. A
successful process exit or `graph.status==='succeeded'` in restored
local JSON does NOT verify the independent physical postcondition.

### Narrow current read-only surface, no allow-list forgery

Keep the executable `task.graph.run` (and nested runbook
`task_graph`) fail-closed at #01's actual source admission boundary.
Use independent, existing, non-shell APIs for authorized inspection:
`task.graph.get`, `task.graph.list`, `task.artifact.list`,
and `runbook.get/list`; assertions use separate `verify.assertions`
but their postconditions require their own scope and trusted input.
Artifact verification (`task.artifact.verify`) hashes existing
path-policy scoped files and is a separate readback, NOT proof of an
admitted native dispatch. `task.graph.prune`/`runbook.prune`
delete local metadata and are NOT read-only.

New #01 source tests operate on a directly seeded TEMP `TaskGraphStore`
without shell: repeated list/get/artifact metadata reads preserve original
UNKNOWN state, attempts and runCount, leak no payload/output and do not
claim `progressVerified`; the same reads remain accessible after a
cloned direct graph request is denied. This is the only justified
read-only-path preservation in this round. There is NO change to the
native dispatch guard or #31 Git executor code.

### Required provider for later compatibility (still BLOCKED)

Before any shell job can execute, a real rollback-external trust root
must verify signed original immutable
`logicalMutationId/requestId/fingerprint/sourceSha/worktreeId`,
current owner/device/session and ownerEpoch + grantGeneration, and
atomically commit a single-use dispatch lease against revoke-start.
Unknown response/final ACK cannot produce a new `graph_id` or
permission to replay; only authenticated read-only outcome reconciliation
is allowed. This service and an installed protected HIGH Broker have
NOT been deployed/attested. Do not add an always-true CAS, local
"readonly command" string heuristic, or weaken #781 hostile QA.

**#826 remains DRAFT, CI RED, production P0 NO-GO, #587 OPEN.**
