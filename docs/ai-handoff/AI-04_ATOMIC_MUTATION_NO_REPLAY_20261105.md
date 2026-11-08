# AI-04: Atomic authorization, no-replay and Windows effect-admission contract

Status: **SOURCE-ONLY / WINDOWS PRODUCTION NO-GO**. This document does not authorize CORE, native launch, broker elevation, installations, or merging #1085. No shared source files changed.

## Frozen integration base

- Candidate: #1085, \`coord/connection-v2-release-candidate-20261104\` at \`25227d0d3361e95d6cf79679212bd81dc4c2a08f\`
- V2-07 source: #1083 at \`20d4252eb10223a2c134aa25bba5107ed6a884f9\`
- Windows CORE/CAS source: #1067 at \`c40ee2db1465d0ea457ffdc36dc9566b385d20b1\`
- This PR changes only \`src/core/atomic-mutation-authority.ts\`, \`test/ai04/atomic-mutation-authority.test.ts\` and this handoff document.
- The existing AI-04 #987 remains untouched. It covers protected Broker receipt trust and is not a replacement for Connection v2 authority.

## Current, evidenced gap

In #1085 \`AgentBroker.request()\`, the WebSocket-scoped callback returns a Boolean, then the Hub checks connection identity and later invokes \`sendPending()\` / \`socket.send()\`. There is no atomic cross-process revoke-vs-send linearization point in that code. The local \`pending\` UUID Map also cannot serve as a durable deduplication index after process restart. #1083's no-replay reconnect path correctly refuses to replay mutation pending requests, but it does not alone solve new request UUIDs for the same uncertain semantic effect.

#1067 has independently scoped \`remote-mutation-cas.ts\`, protected Broker dispatch fence and \`core-windows-mutation-dispatch.ts\`, but that staging source is not automatically an integrated, independently attested Windows Agent admission path. \`CORE_EXECUTOR_DISPATCH_ENABLED=false\` must remain unchanged.

## Required production protocol

1. **Authenticated socket:** Control Plane provides server-issued \`ownerId\`, \`deviceId\`, strictly monotonic \`authorizationEpoch\`, \`leaseExpiresAtMs\`. Hub pins the tuple at HTTP 101. Agent-03 owns its persistence and invalidation on revoke, rotation, re-pair and SAFE mode. Owner/device identities MUST be verified from authority, never request JSON.
2. **Immutable input:** Snapshot the exact UTF-8 Agent request frame before the first \`await\`. Compute SHA-256 over those immutable bytes and bind capability, exact effect identity, and UUID.
3. **CAS-before-dispatch:** Independently trusted authority reserves \`(deviceId, requestId)\` durably, also committing intent identity/fingerprint, owner, epoch and lease. Duplicate requests are denied even when the earlier ACK is lost or reservation belongs to a prior epoch. A duplicated UUID with a new payload is a conflict, not an authorized retry. A new UUID representing the *same uncertain semantic effect* must also be barred by the distinct durable semantic-effect reservation (CLEAN-10).
4. **Revocation ordering:** The *same* authoritative security domain defines a linearizable ordering of epoch/lease revoke and the dispatch ticket. An async Boolean verifier followed by an unguarded \`socket.send\` is insufficient. Revocation committed before dispatch must yield **zero mutation frames**. When socket scheduling wins before revoke, the result is **DISPATCHED_UNACKNOWLEDGED**, not execution proof.
5. **Separate Windows native effect gate:** Even if a frame was accepted into the socket buffer before revoke, the protected native Agent/Broker must validate the exact reservation, current owner/device epoch and active lease, protected process/image/OS identity, unique effect ID and one-time commit *immediately before* each OS effect. An expired/revoked epoch or unavailable authority denies. This is the final safety boundary for frame-versus-effect races.
6. **UNKNOWN stays UNKNOWN:** If the dispatch send throws, transport drops, timeout occurs, Broker commit ACK is lost, native effect result is unavailable, or reconnect occurs, never rerun the callback. Retain tombstones indefinitely subject to independently proven secure archival. Query authoritative records/read-only OS observations for reconciliation.
7. **ACK binding:** Match response request UUID **and exact live socket instance/connection epoch**, not merely deviceId. A stale ACK must not mark a new mutation successful. A new user intent needs new owner authorization and a new semantic reservation.
8. **Fail closed:** No verifier, mismatched owner/device, stale epoch, invalid/expired lease, missing CAS trust root, unverifiable receipt, failed native attestation, disconnected authority or uncertain result must not fall back to local in-memory/SQLite-only approval. Do not fake success with cached credentials.

### Critical type distinction

Agent-03's \`authorizationEpoch\` is a **monotonic integer** from Control Plane. #1067's \`RemoteMutationCasClient.epoch\` and CORE \`deviceEpoch\` are **UUID-valued witness/incarnation identifiers**; CORE also has a separate numeric \`ownerEpoch\`. Never simply cast the numeric Control Plane epoch to the UUID witness epoch. An owner-approved mapping / binding receipt must be defined and verified by AI-03 and the native authority.

## Integration handoffs

- **AI-03:** Supply authoritative, persistent owner/device \`authorizationEpoch\` and short lease; implement atomic revoke/rotation invalidation and a reservation endpoint hosted outside Agent and Hub rollback domains. Include server identity/pinned signed receipts and network failure denial.
- **V2-07 / #1083 owner:** Replace the Boolean-only mutation path with a mandatory reservation/dispatch fence on every remote mutation. Keep existing read-only reconnect budgeting and no mutation replay. The new coordinator contract models this but is not wired to \`AgentBroker\` by this PR.
- **V2-08 / #1085 owner:** Wire only after exact source SHA review. Attach the authoritative per-socket owner/device verifier in remote-only admission. Do not accept a deviceId-only Control Plane result. Re-run CLEAN-10, CLEAN-14, V2-03, Windows Node 22/24, and release gates on one exact integration SHA.
- **AI-05 / #1067 owner:** Consume only signed, source-verified CAS reservation evidence. Validate numeric authorization epoch against the native witness/epoch mapping, require per-effect \`admitNativeEffectOnce\` under protected Broker token/image and independent monotonic CAS. Keep \`CORE_EXECUTOR_DISPATCH_ENABLED=false\`; do not use a Hub-enqueued frame as native admission. Preserve Job Object, kernel attestations and no-rollback/no-replay tests.
- **AI-04:** Own this contract's test matrix. Do not modify \`src/core/agent-broker.ts\`, \`src/hub/agent-websocket.ts\`, \`src/agent/native-agent.ts\`, \`src/agent/runbooks.ts\`, native Broker sources or shared #1085 integrations without the respective single-writer handoff.

## Negative tests and evidentiary scope

\`test/ai04/atomic-mutation-authority.test.ts\` contains deterministic, nonproduction fixtures for missing verifier/provider, wrong owner/device, stale epoch, expired lease, unavailable authority, duplicate UUID, simultaneous mutation submission, lost ACK, reconnect replay, rotation/revoke between reservation and dispatch, send failure, separate protected native admission and one-shot OS effect.

This test authority is **in-memory and NOT production-safe**. It verifies ordering contracts only. It does NOT establish distributed durability, a real Windows native image/token, actual Control Plane DB behavior, a signed external reservation, a networked revocation race, the protected broker, or physical two-PC failover. Those remain separate NO-GO gates.

Run Windows acceptance on exact HEAD, without duplicate active runs:

\`\`\`powershell
npm ci
npm run typecheck
node --import tsx --test test/ai04/atomic-mutation-authority.test.ts
node --import tsx --test test/v2-07/round2-revocation.test.ts
node --import tsx --test test/clean14-revocation-dispatch-negative.test.ts
node --import tsx --test test/v2-03-mandatory-remote-authorization.test.ts
npm run build
\`\`\`

Production remains **NO-GO** until those integrated, protected *real Windows* source and physical negative checks succeed on identical SHA. Passing standalone contract fixtures is not a release gate.
