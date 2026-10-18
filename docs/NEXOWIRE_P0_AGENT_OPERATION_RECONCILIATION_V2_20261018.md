# Agent Operation Journal v2 / Hub reconciliation (2026-10-18)

**Scope:** source-only Agent journal + Hub idempotency operation-ID lookup +
read-only reconciliation adapter. No live Agent, Hub, Broker, service, GUI,
OAuth issuer, or production storage was restarted or upgraded by this change.

## Invariants

1. The Agent's per-request UUID and SHA-256 fingerprint are reserved with
   SQLite WAL, synchronous FULL and BEGIN IMMEDIATE **before** any mutation.
   A second atomic, fingerprint-matched `dispatchedAt` CAS commits before
   executor entry. If the reservation or dispatch marker cannot be persisted,
   **do not execute**. This does not prove an operation without a marker caused
   no external side effect: journal paths, deployments and broker boundaries
   may vary.
2. `complete()` uses a terminal-state and fingerprint SQL predicate inside
   an immediate transaction. A duplicate, changed fingerprint or unknown
   historical request ID is never re-executed. Restart recovers abandoned
   in_progress records to UNKNOWN, not failed.
3. A SQLite owner row is checked/claimed under the same cross-process write
   lock. An owner PID that appears alive, including a reused PID, blocks a new
   opener rather than risking an in-flight UNKNOWN. Normal close releases its
   PID+nonce; killed process leaves a stale row for crash recovery. The native
   Agent's separate per-device singleton lock is still mandatory.
4. Journal **never contains** command text, tokens, paths, payloads, stdout,
   stderr, original tool responses or environment contents. Recorded evidence
   is strictly typed metadata: `shell_exit`, `file_write_ack` and
   `service_readback`. Shell `processExitCode`, `taskSuccess` and
   `timedOut` are not confused with Agent RPC success.
5. `file_write_ack` and `service_readback` are deliberately
   `evidenceVerified:false` in this change. A write acknowledgment does not
   prove durability/independent readback; a service RPC response alone does
   not prove the service's final state. `shell_exit` only proves an observed
   exit, **not** the command's external side effect.
6. `archiveCompleted(before,limit)` moves only succeeded/failed entries into
   a metadata-only SQLite archive within one atomic transaction. Archived IDs
   and fingerprints remain queryable and continue to block replay. UNKNOWN and
   in_progress never archive. `checkpoint()` can explicitly truncate a
   checkpointable WAL; it fails on SQLITE_BUSY rather than inventing success.
   This does **not** claim unbounded retention has become bounded: tombstones
   remain permanently until a separately verified immutable anti-replay
   retention scheme exists. Capacity exhaustion fails closed.
7. Prior to SQLite open/recovery, `operation-journal-wal.ts` streams the
   WAL header and every frame, validates page size, salts, framing and the
   cumulative SQLite checksum (both endian variants). A torn or checksum-bad
   tail blocks Agent startup rather than allowing SQLite's normal recovery
   to discard it and possibly lose an anti-replay reservation. This is an
   intentionally strict availability tradeoff. Files remain untouched on
   validation failure; an operator must investigate and recover from a
   separately trusted backup. Reference: https://www.sqlite.org/fileformat2.html.
8. The Hub's `IdempotencyStore` no longer silently trims historical keys
   when full. It rejects new reservations with `IDEMPOTENCY_STORE_FULL`
   instead. Failed completion persistence restores the old in-memory status.
   A terminal Hub status only attests the Hub record, not the OS postcondition.

## Recovery runbook

1. Preserve exact UUID from the error's `operationId` or the original
   idempotency record. NEVER retry an UNKNOWN mutation, especially shell,
   append/write, service/registry, installer or process-changing calls.
2. With Agent offline, use
   `operations_idempotency_list({operation_id:"<original UUID>"})` or the
   original `key`. The MCP tool filters results by credential/device scope.
   A matching record proves only Hub tracking. An empty result may simply
   mean the caller did not supply an idempotency key initially, the Hub record
   was never committed, the scope excludes the device or the record is absent.
3. With a compatible Agent online, use
   `agent_operation_status({device_id:"<authorized exact ID>",request_id:"<UUID>"})`.
   Missing/not found does **not** prove no execution. Compare operation ID,
   capability, original device identity and independently reconstructed
   Agent fingerprint. `reconcileAgentOperation()` is a conservative pure
   adapter: offline, missing, mismatch and prior UNKNOWN remain UNKNOWN.
   It never auto-retries or asserts a physical side effect.
4. Confirm shell exit and timeout, independently read file contents/metadata,
   and inspect service actual state, depending on the operation. Only after
   target-specific read-only postconditions can an operator decide whether
   to issue a **new explicitly authorized** mutation.

## Regression evidence / limits

- `test/agent-operation-journal.test.ts`: existing v1 persistence,
  corruption, failed outcomes, overflow and token-free DB invariants.
- `test/agent-operation-reconciliation.test.ts`: mark/complete CAS,
  concurrent opener denial, actual killed child-process recovery to UNKNOWN,
  v1-schema migration, tombstone archive + checkpoint, offline Hub ID lookup,
  authorized MCP scope, full-capacity refusal, fingerprint mismatch and
  metadata evidence distinctions, synthetic corrupt WAL header rejection
  and an isolated SQLite max-page-count SQLITE_FULL fault injection.
  Neither fault test modifies a production volume or live journal.
- `test/agent-operation-wal-integrity.test.ts`: isolated real hot WAL created
  by a deliberately killed test-only child (valid recovery to UNKNOWN),
  modified frame bytes, damaged frame checksum, corrupted header checksum,
  invalid page size and truncated frame. None touch the live Agent database.
- `test/agent-operation-status.test.ts` and
  `test/mcp-agent-outcome-reconciliation.test.ts`: read-only status and
  Hub/MCP ambiguous-error handling.

**Still unproven:** real ENOSPC volume fault, exhaustive malicious or
concurrent WAL/SHM tampering, full ACL/rollback/backup policy, independently
verified postconditions for file/service effects, end-to-end two *live*
upgraded Agent/Hub devices, authenticated offline Agent journal replication,
and on-wire reconciliation across a real reconnect. PID liveness can
conservatively block a new owner after PID reuse; manual incident recovery
would be needed. SQLite metadata and raw SHA-256 fingerprints need protected
local ACLs; low-entropy payload guesses may be tested offline against a
SHA-256 fingerprint even without the original payload. Consider keyed,
protected fingerprints in a separately versioned migration.

**Release gate:** no production acceptance from source tests alone. Protect
`agent-operations.sqlite`, `-wal` and `-shm` together; verify packaged
Node's `node:sqlite`, Windows ACLs, backup consistency and safe rolling
migration. Do not delete/rotate either Hub or Agent tombstones to reclaim
space unless a separately verified anti-replay authority remains.
