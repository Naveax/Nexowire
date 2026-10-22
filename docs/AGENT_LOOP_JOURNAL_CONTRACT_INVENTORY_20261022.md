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
