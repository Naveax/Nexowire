# Nexowire #06: CORE/ROOT grant epochs and #616 durable worker compatibility

Date: 2026-10-21. Source-only acceptance; production NO-GO.

## Immutable sources

- main source base for #613: `4c5c810134c020cd04a5ef2be5c1138ea1954ad0`, including merged #605.
- #613 pre-follow-up head: `d019e99efd46fcb76262528ffe122ad1c0a4087d`, CI `39598086598` SUCCESS.
- #596 HEAD `335046569a38f3a1a3fc82bf851f9b7df7640fdb`, CI SUCCESS.
- #616 DRAFT exact HEAD `94b92e01219aca3cd4ca86775fe4b61a72ac53c4`, CI SUCCESS, parent is #596 rather than main.
- Original #616 `TrustedTransferAuthority.acquire/assertCurrent` is a **worker/multi-Hub lease authority**, NOT the owner CORE/ROOT grant. These epochs must never be conflated.

## Added #06 module and tests

`src/mcp/cross-device-transfer-owner-grant.ts` exports
`ownerGrantEpochGuard(admission, source, clock)`: a Connection-only
`TransferAuthorization` callback for #613's
`DurableTransferContinuity` source adapter.

`TransferGrantFence` binds owner, project, source/target devices,
immutable owner-grant epoch and privilege intent (standard, CORE or ROOT).
For ROOT it binds both a distinct root session generation and expiry.
A `TrustedTransferGrantSource.current(binding)` must revalidate a
current, independently authenticated owner grant on each checkpoint
operation. It must **not** use MCP fields, UI preference toggles, Agent
claims or a mere `consent.exe` presence as proof.

An absent/throwing authority, revoked/disconnected owner, changed
owner epoch or project/device, CORE without an attested local Broker,
changed/expired ROOT session epoch, or invalid clock returns deny.

The Connection state machine introduced by #605/#613 persists chunk
UUID, epoch, offset, SHA and CAS revision before dispatch; observes ACK
without crediting bytes, marks lost ACK UNKNOWN, and moves persisted
offset only after independent destination readback. This guard prevents
currently revoked grants from settling that checkpoint.

**Important limitation:** this is a negative authorization *adapter*.
Its `brokerAttested` field must be supplied by future verified signed
Windows Broker/Guardian code, not from the ControlPlaneIdentity's CORE
preference. `src/security/authorization-explain.ts` deliberately reports
the present CORE state as `PAUSED_UNVERIFIED` and ROOT as
`sessionBound:false`. No code here launches an elevated helper or grants
Windows rights. Checking a grant before a later network write is not
atomic with the write; #08 must integrate an independent trusted
revocation-to-dispatch fence with #616's worker lease. Race unresolved.

## Source/test matrices

New `test/cross-device-transfer-owner-grant.test.ts` uses disposable
SQLite FULL/WAL checkpoints and synthetic signed-grant lookalikes.
Five deterministic cases:

| Scenario | Expected / observed |
| --- | --- |
| CORE revoked during destination readback | Authorization fails before checkpoint CAS; offset unchanged |
| CORE UI preference without attested Broker | Transfer denied before durable job reservation |
| ROOT privilege generation changed, grant epoch bumped or lease expired | Stale ACK, reconnect and readback all denied |
| Lost ACK with changed destination epoch, corrupt/partial SHA, cancel | UNKNOWN, no mutation replay, cancel_pending |
| Wrong project/device or missing authority | Deny, no successful ACK/cancel transition |

Main #613 worktree: `npm run typecheck`, `npm run build`,
`node --test --import tsx test/cross-device-transfer-owner-grant.test.ts
test/cross-device-transfer-continuity.test.ts` => 14/14 PASS
(5 new + 9 previous).

Isolated compatibility with #616 HEAD `94b92e0`, only four
Connection source/test files overlaid locally, no #08 changes:
typecheck/build PASS, 44/44 targeted tests PASS including
`test/artifact-store-job-failclosed.test.ts`,
#596 current one-call worker, #597 QA and Connection tests.

Tests use temporary localhost file/journal fixtures, mock owner-grant
authority and no production credentials or physical connectivity changes.

## Exact integration boundary to #08/#616

1. #08 `CrossDeviceTransferJobs.start` creates immutable job binding
   from persisted owner/account/project/source/target/stage, not caller
   attestation. The signed Broker must supply the actual destination
   connection epoch. #616 external CAS epoch/token is separate.
2. Before each `TransferRemote.write` mutation, externally reserve the
   exact pending chunk requestId/offset/hash in a truly authoritative CAS
   checkpoint and check **both** independent worker lease and the
   owner/CORE/ROOT grant (if the operation requires elevated privileges).
   A worker cannot infer an elevated Broker from CORE preference alone.
3. Carry pending UUID, authenticated device, epoch and grant reference in
   the Broker-executed write; current #596/#616 `TransferRemote.write`
   lacks this transport correlation ABI. Reject old/foreign ACK.
4. Check owner grant and worker epoch after a potentially delayed
   source read and immediately before native mutation/publication;
   the current #616 `assertFence('WRITE')` call runs before the
   awaited source read and may race with revocation. Use trusted
   atomic revocation-to-dispatch fencing. No blind UNKNOWN replay.
5. On reconnect, only an independent exact destination prefix
   readback can mark a pending chunk verified; wrong hash/owner/device
   leaves UNKNOWN. Cancellation preserves uncertain writer stage
   (no delete, no quota refund without fenced writer + deletion proof).
6. Final COMPLETE requires #08 atomic no-overwrite publish plus trusted
   destination artifact hash/size/device check, not ACK or metadata alone.

## Production blockers

- Current physical Native Agent 1.0.5 cannot attest #616 or #613.
- #617 signed elevated Broker/one-time owner consent, Win32 token trust,
  revocable effective CORE and session-scoped ROOT privilege not accepted.
- #587 monotonic witness plus live multi-Hub lease, trusted authorization,
  #601 budget tombstone and artifact publisher readback not yet fully wired.
- #596/#616 currently DRAFT and not a combined production transfer.
- No controlled two-device staging physical cable/tunnel outage or
  production token revoke performed.

No live Agent/service restart, UAC interaction, ACL edits, external
storage write, Artifact Store mutation or production release.
