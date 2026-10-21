# S1 Connection Core #06: durable cross-device job continuity acceptance
Date: 2026-10-20
Status: **source/staging adapter PASS; production NO-GO**

## Scope and authoritative evidence

- Source base: `fda2a2da164ea7c6a2fe2271fc669f1fd623cede`.
- Merged #547, #569, #580 (device-bound Journal reconciliation) and #589
  (512KiB Artifact Bridge fault injection) are already on main.
- Issue #588: OPEN. #08 PR #596: OPEN/DRAFT, separate large Artifact Bridge
  work, exact previous HEAD `22675eeb46b7360622a0800ac5d293fee63b2e68`.
- **Neither #596 nor this new connection continuity module is yet a
  deployed cross-device job in production.** The existing
  `src/mcp/cross-device-file-transfer.ts` pilot explicitly does NOT support
  durable resume after loss; it best-effort removes its staging file. Do not
  falsely claim that the old pilot has acquired these capabilities.
- Actual Naveax device (Win11 build 22631): read-only `machine.health` PASS
  2026-10-20T20:18:13.883Z; actual Work PC (Win10 build 19045): PASS
  2026-10-20T20:18:16.241Z. Both reported Agent v1.0.5.
- No production token revoked; no live Agent, Hub, Broker or device restarted,
  updated or physically disconnected. No user file was read/written/deleted.

## Added implementation (Connection Core ownership only)

`src/mcp/cross-device-transfer-continuity.ts`: metadata-only durable
reconciliation state machine, with **injected** `TransferCheckpointStore`,
`DestinationReadback` and `PublishedArtifactReadback` interfaces.
No modifications to #08's `src/workspace/artifact-bridge.ts`,
`src/mcp/artifact-bridge-device-ingest.ts`, or any persistent Artifact store.

Immutable job identity: UUID, authenticated owner, exact source/destination
device IDs, immutable source digest + length. State includes durable CAS
revision, authenticated connection epoch, persisted byte offset, optional
in-flight per-chunk UUID, offset/length/SHA-256 and ackSeen flag. The
controller never changes a persisted row without an atomic revision CAS.

1. `reserveWrite` commits an in-flight record **before** permitted dispatch.
   It generates each UUID itself. Only one pending chunk and no overlap;
   all writes are <=64KiB and at the exact persisted offset. If the
   journal CAS fails, there must be no network dispatch.
2. `observeAck` checks job scope, epoch, exact UUID and offset/hash. A
   timely ACK **cannot** itself advance byte offset, prove a side effect
   or approve replay. Old-socket / wrong-device / owner ACKs are denied.
3. `onReconnect` increments the epoch (only a trusted Broker caller
   should invoke it), marking an in-flight mutation **UNKNOWN**. No
   automatic write retry, even with identical requestId or Agent instance.
4. `reconcilePending` requests an independently verified **destination**
   chunk readback. Only the exact destination ID, offset, size and chunk
   SHA-256 moves the persisted offset forward. Missing, partial, corrupt,
   wrong-device or unavailable evidence leaves `UNKNOWN` and blocks
   dispatch. This function NEVER initiates a new mutation.
5. `cancel` sets `cancel_pending` when a write is uncertain. It does
   not delete an unknown partial stage or allow a late ACK to reopen work.
6. `confirmPublished` needs an independently invoked trusted
   #08 publisher readback adapter matching destination ID, total bytes,
   and final SHA-256. A caller-provided hash string cannot certify success.
   This state machine **does not perform publication**.

## Reproduced negative faults

`test/cross-device-transfer-continuity.test.ts` uses a disposable
SQLite WAL/FULL journal as a real atomic checkpoint backend, synthetic
owner/device identities and a 221KiB+17 fixture. The transport-failure test
uses an ephemeral localhost `ws://127.0.0.1` socket with a deliberately
dropped write response. These are staging/test fixtures, not authenticated
production TLS/WSS or a real device disconnect.

| Fault | Expected & tested |
| --- | --- |
| Transport loss after mutation sent, ACK absent | UNKNOWN; no blind replay |
| Durable store controller reopened after loss | Reattaches at saved revision/offset |
| Independently verified exact chunk | Offset resumes only after readback |
| Partial chunk or hash mismatch | UNKNOWN, retry blocked |
| Stale ACK after epoch increment | Rejected, offset unchanged |
| Wrong owner/device | Access denied, cannot advance job |
| Wrong request UUID or chunk SHA | ACK ignored |
| Concurrent writers | Exactly one compare-and-swap reservation |
| Cancel with ambiguous write | cancel_pending; no delete/resume |
| Unverified publication digest | Cannot mark job complete |
| Source/destination physical test | NOT TESTED |

The test's synthetic SQLite persistence **does not** mean production
`TransferCheckpointStore` is wired or that a production rollback-safe
authority exists. Existing Agent Journal v2 monotonic anti-rollback #582
is independently unresolved. The module is additive acceptance scaffolding.

## Existing regression and release gates

Run `npm run typecheck`, `npm run build` and:
```bash
node --test --import tsx test/cross-device-transfer-continuity.test.ts
node --test --import tsx test/connection-recovery-faults.test.ts test/connection-journal-reconciliation.test.ts test/connection-fault-proxy.e2e.test.ts test/cross-device-file-transfer.test.ts test/cross-device-mcp-transfer.e2e.test.ts
```

Production remains **NO-GO** until all of:
- #08 and #05 safely wire truly durable stage reader/checkpoint/PUBLISH
  proofs to the controller; expose tenant/account scoped transfer API,
  cancellation authorization, replay tombstone retention and retention/space
  limits. No #08 code is changed here.
- New Agent/Hub signed canary is actually installed and version matrix
  checked on both devices; v1.0.5 metadata cannot attest the new build.
- Staging signed WSS physical fault injection, reconnect storm and
  verification of late ACK/owner revoke and traceable requestId provenance.
- Independent reader/postcondition proof is not merely an untrusted
  Agent ACK or caller-provided SHA. Unknown mutating outcomes never
  auto-dispatch, even if readback is unavailable.
- 1GiB / >256MiB large-file storage acceptance and per-chunk quotas
  remain #08/#588/#596 owner scope, not Connection Core.
- Exact-head CI passes; source-only tests are not production acceptance.

Separate Windows full-suite failures / #553 filesystem security are not
waived by the focused connection tests.
