# Idempotency status and lost-acknowledgement continuity

## Scope

Nexowire's existing idempotency journal records an operation ID, request fingerprint,
target device, capability and state without persisting mutation payloads or results.
The journal supports safe operator inspection; it is not a transaction log or a
guarantee that a remote mutation has (or has not) happened.

## Inspecting status

Use `operations_idempotency_list` with `key` for an exact idempotency key,
or with `limit` to list recent visible records. Access requires operator/admin
permission (or trusted static authorization), plus the credential's device scope.

For directly granted device IDs, history remains visible if that device is offline.
Route-only grants follow the *current* authorized route and cannot expose records
for unrelated or no-longer-selected devices. Unrestricted trusted credentials may
inspect retained records regardless of current connectivity.

The tool returns metadata only: `key`, `operationId`, `targetId`,
`capability`, `fingerprint`, `status` and timestamps. It never returns the
original file content, request body or cached mutation result.

## Interpreting states

- `in_progress`: the hub accepted the idempotent operation but has not finalized it.
- `succeeded`: the hub received and recorded a successful provider result.
- `failed`: the hub recorded a failure, not necessarily proof that no side effect occurred.
- `unknown`: the remote operation's final effect is ambiguous, for example a lost
  acknowledgement or a hub restart while execution was in progress.

Once provider execution has been dispatched, a later local journal completion
failure must not be treated as proof that the remote mutation failed. The
orchestrator records `unknown` when it can persist a recovery state. If the
remote outcome was already durably confirmed, a subsequent audit/log failure
must not overwrite that `succeeded` or `failed` outcome. A tool-level reporting
error may therefore coexist with a journal record stating the confirmed
remote operation outcome; inspect the exact key before another mutation.
If the audit sink also rejects the recovery error event, the MCP response
includes `recoveryAuditFailed=true` instead of allowing that secondary
failure to erase the original error. If both the original journal write
and the recovery journal write fail, the MCP response sets
`recoveryJournalFailed=true` and deliberately omits `persistedStatus`,
marking the side effect unconfirmed. This is operationally degraded and
requires investigating journal/audit storage; it does not confer success.

For an `unknown` outcome, **do not automatically retry with a new idempotency key**.
Read back the remote target state using an authorized read-only operation, then
decide manually whether a new write is needed. A repeat call using the same key
and matching fingerprint is intentionally rejected rather than executed twice.
An already successful record can survive a hub restart even when its result body
was only cached in memory.

## Journal startup and write-failure safety

The journal loads using one shared asynchronous initialization promise, so an
overlapping request cannot mistakenly treat historical keys as absent while
the file read is pending. The store only reports a new key as created after
its initial `in_progress` record has been persisted. If that initial
journal write fails, the uncommitted reservation is removed from memory
before the error propagates; the remote mutation was never dispatched.
Reservations and completions in the same store are serialized to prevent
a concurrent successful journal snapshot from resurrecting a different
reservation whose initial disk write failed. Status queries wait for the
pending journal mutation before returning an answer.

These checks are for one in-process store instance and do not replace an
inter-process file lock or a durable distributed transaction protocol.

## Current limitations

The store is scoped by credential/device authorization but not yet partitioned
by an independent account ID in its persisted schema. The existing role gate
therefore intentionally keeps this inspection tool limited to operator/admin
credentials. No general-user status endpoint is implied by this change.

Records are bounded and can be evicted according to store retention/capacity;
absence is not proof the operation never happened. This change does not deploy
to running agents, guarantee remote rollback, add resumable writes or perform
automatic reconciliation of `unknown` outcomes.
