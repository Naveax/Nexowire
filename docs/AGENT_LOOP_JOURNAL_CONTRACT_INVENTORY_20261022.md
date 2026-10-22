# #01 source inventory for P1 #780: deterministic loop / Journal bridge

Date: 22 October 2026. Scope: **inventory, minimal metadata-only type
contract and read-only source QA**. Stacked child of #712 at
`1d78a7a9174e91e3b6baaa1319a063917391a64f`. No native execution,
Agent installation, protected Broker, cloud resource, database, UAC or VM
change. This document does not assert P0 #587 acceptance.

## Current source inventory at the exact parent SHA

| Owner / source | Existing verified behavior | Gap for #780 |
| --- | --- | --- |
| #01 `src/agent/operation-journal.ts` | `AgentOperationRecord` persists exact requestId/fingerprint/capability, in_progress/succeeded/failed/unknown, dispatchedAt and local evidence; inspect is read-only; markDispatched one-time CAS | Local SQLite/WAL is not rollback-external; local evidence != external effect proof |
| #01 `src/agent/remote-mutation-cas.ts` | HTTPS reservation and `MonotonicTrustRoot.reserve`, result created + sequence | No attested off-host non-restorable service, no native atomic commit-for-dispatch vs revoke-start |
| #01 `src/agent/broker-external-dispatch-fence.ts` | Signed nonce/owner epoch permit, process-local revoke fence | Prior independent #731 adversary shows late remote signed permit can execute across two Hubs; process flag is not atomic |
| #01 `src/agent/postgres-bound-grant-cas.ts` | Owner/device/session grant generation and remote conditional reservation client/source | PostgreSQL and independent remote CAS physically unverified; reserve does not attest native commit or postcondition |
| #01/#02 `src/operations/agent-operation-reconciliation.ts` | Pure read-only reconciliation; `automaticallyRetryable:false`, no assumption missing row means no side effect | No physical proof of mutation postcondition; cannot turn local success into COMPLETED_VERIFIED |
| Existing Agent `src/agent/task-graph-store.ts` | Durable status/specHash/dependencies and resume; interrupted running becomes unknown | `retryUnknown:true` explicitly resets unknown jobs to pending, unsafe to reuse for unchecked mutating coding-agent tools |
| Existing Agent `src/agent/runbook-store.ts` + `runbooks.ts` | Persistent runbook, step retries, resume | `retryUnknown:true` permits retry of unknown task_graph step; this must not be wired to mutating P1 loop without independent reconciliation |
| #08 checkpoints | Task/runbook checkpoint persistence already exists | Owner #08 must provide owner/device-scoped encryption, redaction, revision/CAS + real authority readback before resume |

## Minimal #01 metadata contract

`src/agent/agent-loop-journal-contract.ts` defines
`AgentLoopCheckpointV1Schema` and a **pure** read-only
`reviewAgentLoopCheckpoint` projection. The schema binds task/step,
immutable original mutation requestId/fingerprint/capability,
owner/device/deviceEpoch/sessionEpoch and numeric ownerEpoch/
grantGeneration, optional git source SHA, conservative state and the
original errorCode. It rejects raw commands, tokens and extra keys.
The projection never exposes execute/retry/COMPLETED_VERIFIED: absent
or UNKNOWN journal => RECONCILE_REQUIRED; changed UUID/fingerprint/
epoch => STOP; local terminal success => READ_ONLY_INSPECTION, not
physical effect verification.

This is an inventory/guardrail shape, **not a persisted checkpoint
store or authority**. TypeScript readonly and frozen projection do not
prove external immutable storage. Do not replace Agent Journal,
#08 checkpoint source or #04 grants with this advisory helper.

## Missing authority API for #712/#587 (BLOCKED)

The independently administered, non-restorable authority is still
undeployed. Current `reserveIfCurrent` is **not** native execution
permission. The required *owner* source contract remains:

1. `reserveIfCurrent(requestId,fingerprint,capability,scope,reserveNonce)`
   returns a signed RESERVED id, global sequence and immutable owner/
   device/session epoch + grant generation; duplicate created:false
   NEVER authorizes a second execution.
2. `commitIfCurrent(reservationId,dispatchId,requestId,commitNonce,
   protectedBrokerAttestation,ownerEpoch,grantGeneration)` must atomically
   order RESERVED -> ADMITTED_FOR_DISPATCH against **revoke-start** on
   the same external trust root; late commit => DENIED, zero effect.
3. `revokeAndDrain` durably fences new commits first and only confirms
   drained when earlier admitted effects are independently completed
   or cancelled. A lost ACK => UNKNOWN, not blind replay.
4. `readOutcome(requestId,dispatchId)` is authenticated **read-only**
   reconciliation. #754 final Native publication verifier and destination
   hash must be cryptographically tied to exact admitted dispatch before
   any COMPLETED_VERIFIED; disconnected or unsigned => UNKNOWN.

The prohibited/blocked dispatch patch was NOT retried here, including
through alternate tools. No #03/#04/#08 files edited.

## Minimal safe QA / owner handoff

New `test/agent-loop-journal-contract.test.ts` is pure, with **no
device, database, VM or native effect**. Cases: UNKNOWN mapping;
missing journal after rollback; in-progress dispatched; original
request ID and owner/device/session/epoch immutability; wrong
fingerprint/capability; local terminal proof insufficient; reject
unrecognized payload/secret fields and fake VERIFIED status.
Independent QA #18 should separately maintain untouched real
reserve->revoke-start->late commit negative fixtures. #08 owns durable
encrypted snapshots and opt-in resume; #04 owns grant readbacks; #03
owns installed HIGH Broker and physical dispatch. No P1 coding loop
should consume `retry_unknown` as a mutation replay permission.

**Release:** #780 P1 inventory only. #587 P0 OPEN, production NO-GO;
no installed signed HIGH Broker or off-host CAS claim.

## #781 independent cloned-runbook adversarial finding (22 October)

#18 independent DRAFT PR #781 HEAD `89a865363829c8c30a74de1516e53a697549c05b`,
exact GitHub CI `39816363122` **7/7 SUCCESS**, reproduces an **UNSAFE
NEGATIVE** in actual `executeDurableRunbook` source. An injected synthetic
OS-effect callback raises `MUTATION_STATE_UNKNOWN` after acting once;
`runbooks.ts` catches it, records step `failed` with original errorCode,
not `unknown`. A cloned `runbook_id` derives another graph ID;
a source-only second callback is dispatched, even with `retry_unknown:false`.
This is not a claim of two physical Native dispatches.

The #01 advisory checkpoint now requires stable `logicalMutationId`
(UUID) **in addition to** stable original `requestId`, fingerprint,
capability, owner/device/session and grant epoch. Optional `runbookId`
is a mutable organizational alias, NEVER the logical mutation key.
The pure `reviewAgentLoopContinuation` requires the original binding
from a future independently verified authority. Missing original mapping
returns RECONCILE_REQUIRED; cloned alias with a new requestId or logical ID
returns SCOPE_MISMATCH/STOP; clearing original
`MUTATION_STATE_UNKNOWN` returns STOP with original provenance preserved.
All decisions are read-only, mayReplay:false, mayDispatch:false.

**Important:** This does NOT patch `RunbookStore`, `TaskGraphStore`,
`executeDurableRunbook`, or their runtime dispatch. Their
`retry_unknown` and cloned-ID unsafe paths remain as tested by #781;
#08 and the Agent loop runtime owners must enforce original logical
identity and independent outcome readback before any resumed mutating job.
Even immutable local checkpoint fields can be rolled back together; a
fresh minted logical ID after total rollback is undetectable without
real independent non-restorable authority (#587). No physical Broker or
external service deployment. The prohibited atomic CAS patch is not retried.

## #794 worktree source-drift independent negative (22 October 2026)

Independent #18 DRAFT PR #794, HEAD `765f59f1d7c5a0137fe2fd5c4515016ab4bdcd55`,
exact CI `39823178271` 7/7 SUCCESS, reproduces an unsafe
*classification gap*: logicalMutationId/requestId remain the same, but
sourceSha changes after a cloned worktree and #783 originally returns
RECONCILE_REQUIRED rather than explicit SCOPE_MISMATCH/STOP. All existing
decisions already have mayDispatch:false and mayReplay:false; #794 does
NOT establish actual Native replay or independently observed revocation.

The #01 metadata contract now treats original `sourceSha` and
`worktreeId` as immutable. An alias `runbookId` may change, but a
changed SHA or worktreeId means SCOPE_MISMATCH/STOP with original UNKNOWN
provenance retained. A legacy checkpoint lacking either binding parses
only for safe diagnosis and returns STOP; importantly, #794's unbound
worktree fixture still produces explicit SHA drift classification.
These are SOURCE-ONLY checks, not code execution permission.

Trusted workspace enrollment must attach a verified worktree ID and
authoritative root/file-ID evidence. Comparing locally stored UUIDs or
source SHA cannot detect simultaneously restored or forged original
and cloned records. `RunbookStore` and `TaskGraphStore` are unchanged:
#781 FAILED+clone redispatch remains UNSAFE, and #587 external
commit-for-dispatch/rollback-independent witness remains BLOCKED.
No independent #18 QA files were modified, no blocked P0 patch retried,
no live Hub/Agent/Broker/UAC/DB/VM activity.
