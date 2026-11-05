# AI-03 | Connection v2 Control Plane authority

## Source and write ownership
- Stacked on #1085, exact source SHA 25227d0d3361e95d6cf79679212bd81dc4c2a08f.
- AI-03 changes only Control Plane service, its store implementations, migration, negative tests, and this handoff. The V2-08 coordinator keeps exclusive write ownership of #1085's integration branch.
- Source-only; no Cloudflare migration/deploy, credential changes, Windows device operations, feature flag, CORE enablement or merge.

## D1 migration contract
- Add 0022_remote_agent_authorization_epoch.sql **after** existing 0019, reserved CORE 0020 (#1067) and 0021 (#1073). Do not renumber the CORE migrations.
- device_remote_authorization stores deviceId, trusted ownerAccountId, monotonic positive authorizationEpoch and active flag. This is a durable tombstone, intentionally not FK-cascade-deleted with device row.
- D1 triggers increment epoch on credential rotation, device owner change, SAFE/FULL transition, device deletion and re-pair with reused ID. Presence-only writes do not increment epoch.
- Explicit device/owner revocation performs an atomic D1 UPDATE increasing epoch while disabling authorization. Overflow fails with a CHECK constraint rather than silently wrapping or resetting.
- Legacy existing FULL rows are backfilled with epoch 1; legacy SAFE rows receive inactive epoch 1. Production migration must be staged and applied *before* the updated worker.

## API
POST /api/v1/internal/device/authenticate is service-authenticated and accepts only the device credential. It derives current owner and mode from the Control Plane database, then an atomic authority read checks the current owner, credential hash, FULL policy and enabled epoch. It may issue:

    {
      "authenticated": true,
      "device": {
        "deviceId": "id",
        "ownerAccountId": "trusted-owner",
        "deviceName": "display-name",
        "platform": "win32",
        "authorizationEpoch": 2,
        "leaseExpiresAtMs": 1793900000000
      }
    }

The epoch is a positive safe integer; lease expiry is **server time + 30 seconds**. Timestamp above is an illustrative shape, not a live lease. Both fields are omitted for SAFE/revoked devices, whose legacy device-only identity is usable only for servicing/presence and MUST NOT pass strict remote-only Agent admission. Missing migration or authority outage throws; no synthetic owner/epoch/lease fallback.

POST /api/v1/me/devices/remote-authority/revoke accepts owner-authenticated JSON {"deviceId":"..."} and header x-nexowire-confirm: remote-authority-revoke-v1. Cross-owner returns 404, service role is forbidden. A repeatedly unchanged FULL policy and presence update do not reactivate a revoked grant. An explicit owner SAFE -> FULL transition re-enables it. POST /api/v1/me/remote-authority/revoke-all requires an owner session and header x-nexowire-confirm: remote-authority-revoke-all-v1. It atomically invalidates all remote grants belonging to the authenticated owner, not a caller-supplied owner ID. Trusted account deletion/revoke lifecycle integrations must also call store.revokeRemoteOwnerAuthorizations(ownerAccountId) before accepting further remote dispatch.

## AI-04 / Broker verifier contract
Bind each WSS socket to the authoritative full tuple:
- deviceId
- ownerId (maps to Control Plane ownerAccountId)
- authorizationEpoch
- leaseExpiresAtMs

Before **every read and mutation** and any retry/reconnect, fetch current authority over a trusted path. Deny on missing verifier, unavailable authority, stale epoch, expired lease, owner/device mismatch, revoked owner/credential, wrong device or changed SAFE mode. Never transmit an Agent frame for a denied operation. No client echo, local mock or signed CORE receipt can manufacture a remote grant. This numeric lease is not local Windows/CORE execution permission. An uncertain dispatched mutation remains UNKNOWN/no replay.

## Acceptance / blockers
- Node 22/24 and Windows exact-HEAD CI, D1 migration compatibility with CORE 0020/0021, and independent security review are required.
- Actual D1 staging and off-network two-device lifecycle acceptance remain NOT_RUN.
- #1085 production release remains NO-GO pending the coordinated integration and external checks.
