# #42 worker reconnect/lease fencing contract | P1 #780 / coordination #539

Status: **SOURCE-ONLY CONTRACT, native dispatch BLOCKED, physical NO-GO**.

## Source inventory at main 754cc4364822be5fda528f54042fb22a84f19924

- #06 `docs/CONNECTION_CORE_V2_RECOVERY_ACCEPTANCE.md`, Hub `src/core/agent-broker.ts` / `src/hub/agent-websocket.ts`: Hub-local socket epoch rises after reconnect, stale socket ACK loses authority, read-only replay is bounded, and mutating ACK-loss is UNKNOWN. Hub-local epochs are memory-only; not an external lease authority.
- #13 WSS DRAFT #671/#701/#720, `src/product/owner-public-wss-operator-enrollment-proposal.ts`: signed enrollment and per-device profile revision are staging proposals; re-pair/REPLACE/DELETE triggers from #720 are opt-in disposable SQLite fixtures, not a deployed distributed owner authority.
- #07 DRAFT #792 exposes `oauthSessionEpoch` for owner authentication, explicitly not a device/task/grant or protected Broker authorization. OAuth logout must fence cached owner snapshots.
- #35 pairing writer/API is **not available as verified trusted provider**. Main `ControlPlaneService.consumePairing` writes `putDevice` / `putPairing` separately. Neither is a global, non-restorable compare-and-swap for native effects.
- #01 DRAFT #783 and main `reconcileAgentOperation`: requestId/fingerprint observations never make missing Agent journal row evidence of no side effect; final OS effect not proven by local SQLite or a signed WSS hello. `MUTATION_STATE_UNKNOWN` is not retryable.

## Added isolated source-only boundary

`src/coding/worker-reconnect-lease-contract.ts` exports:

1. `WorkerMutationIdentity`: exact owner/device/signer SPKI, owner/OAuth/pairing/issuer epochs, task/worktree/source SHA, original requestId, logicalMutationId, stepId.
2. `WorkerLeaseCheckpoint`: **separate** local session ID, WSS generation, connection epoch, finite expiry and state (`not_sent`, `dispatch_pending`, `ack_lost`, `journal_unknown`). All checkpoint contents are untrusted until independently checked; no secrets or raw OS output stored.
3. `WorkerAuthorityReadback`: required fresh owner/device readback (not a standalone grant). This module does not fetch it, cannot establish its authenticity or prove it was read atomically.
4. `reviewWorkerLeaseReconnect`: read-only fail-closed assessment. Stale owner/paired signer/epoch, logout, revoke, wrong task/worktree/SHA, changed immutable logical identity, expired lease or unavailable readback => STOP/BLOCKED. Pending dispatch or lost ACK always => RECONCILE_REQUIRED, with original request ID. New socket/session => new external authorization required.

Every result has `mayDispatch:false`, `mayReplayMutation:false`, `mayLaunchNativeTool:false`. No execution function is provided, and **NOT_SENT** from a local checkpoint does not authorize a fresh dispatch either.

## Missing independent service contract and handoff

#35/#13 must supply a trusted **multi-Hub atomic** one-use `claimEnrollment` / `readCurrentPairing` / signed SPKI+nonce+ownerEpoch+pairingEpoch+issuerEpoch, with replay-proof re-pair and revoke ordering. #07 must provide strict live OAuth owner epoch and logout rejection. #01/#06 and Native/Broker owner must provide externally linearizable `reserveIfCurrent` -> `commitIfCurrent` that compares immutable task/worktree/source SHA/logicalMutationId/requestId/step and the current owner+pairing+session fencing generations **in the same external transaction as revoke-start admission**, without permitting a duplicate commitment after uncertain ACK. A durable authenticated `readOutcome(originalRequestId, logicalMutationId, dispatchId)` may inspect outcome; only authenticated independent effect readback can settle UNKNOWN, never local reconnection or timeout alone.

A regular SQLite database, generated/mock monotonic counter, JWT/WSS receipt, in-process mutex, cached `readbackVerified=true`, browser consent or cloned task/session ID does **not** meet these gates. When the external authority is absent, `mayDispatch:false` and **BLOCKED** are mandatory. No protected directory, installed Agent 1.0.5, Native Broker, live WSS/D1/OAuth, Cloudflare deploy, physical VM or UAC was touched. CI green is source validation, not physical permission.

## Deterministic test scope

`test/worker-reconnect-lease-contract.test.ts` contains 10 pure negative/contract cases: same-session no-CAS, local reconnect without logical-ID change, pending/lost OS ACK, cloned task/worktree/Git/request, owner/OAuth/pairing/issuer epoch or signer rotation, logout/revoke, offline/forged readback, expired/invalid lease, malformed identity and repeated reconnect after ACK loss.

Handoff state: **BLOCKED_external CAS/Native dispatch**. Do not merge the module into a runnable worker until independent signed authority, non-restorable CAS, cross-Hub adversarial test and physical Broker/Agent acceptance exist.
