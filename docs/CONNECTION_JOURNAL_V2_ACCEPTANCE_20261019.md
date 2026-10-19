# Connection Core v2 × Agent Journal v2 acceptance (2026-10-19)

**Status: source/staging acceptance partially PASS; production BLOCKED.**

Scope: connection replay/epoch, request IDs and cross-device operation provenance.
No existing PR #547 or PR #569 transport source was modified by this follow-up.

## Verified provenance

| Item | Value |
| --- | --- |
| Integration starting source SHA | `cb819d17ee581093d39626f13e985976def17f30` |
| Connection Core PR | #547, merged at 2026-10-18T18:28:47Z, head `4bb72b47132ba53c5f8413915888b471a81a521f` |
| Isolated fault proxy PR | #569, merged at 2026-10-18T18:45:23Z, head `da6b3679cd666a82bfb88d1c181367364706e5f4` |
| Test route | Temporary localhost WSS/HTTP server, synthetic devices and disposable SQLite journals |
| Build | TypeScript typecheck PASS, build PASS |
| Targeted test run | **90/90 PASS** across 16 source/test modules, including the new 4-test cross-layer suite |
| Real Naveax | Agent **1.0.5** listed online; read-only `machine.health` PASS at `2026-10-19T15:52:29.303Z` |
| Real Work PC | Agent **1.0.5** listed online; read-only `machine.health` PASS at `2026-10-19T15:52:32.546Z` |

A successful health RPC proves only connectivity and execution at that instant. Device-directory lastSeen timestamps are older and are **not** used as fresh reconnect evidence. Neither device was physically disconnected, updated or restarted.

## What was exercised

- **Epoch/socket fencing:** Existing `connection-recovery-faults`, `native-session-continuity` and proxy tests prove old sockets and late ACK/events cannot settle the new socket's unrelated work; same instance ID does not permit mutation replay.
- **Concurrent two devices:** Synthetic Naveax route interruption does not affect in-flight Work PC read-only response; exact request ID, exact target ID and bounded read-only reconnect budget are asserted.
- **Lost mutation ACK (new test):** The Agent's disposable SQLite journal persists `succeeded` metadata for the exact UUID before the simulated WSS is closed without ACK. Hub returns `MUTATION_STATE_UNKNOWN`. The test confirms the same UUID cannot start again; the isolated executor is invoked once.
- **Cross-layer fingerprints (new test):** `operationFingerprint` is the Hub hash over target ID, capability, provider ID (optional) and payload; `fingerprintAgentRequest` is the Agent hash over capability, payload and access mode. **These hashes are deliberately different.** Their literal equality is never an acceptance condition.
- **Cross-device/provenance mismatch (new test):** A terminal Agent journal with the right UUID and Agent hash but observed from a different authenticated device is UNKNOWN; missing trusted route identity, wrong Hub target, wrong UUID or modified payload/access mode also fail closed.
- **Physical result distinction:** A matching Agent `succeeded` journal row is only `agent_confirmed`; `evidenceVerified:false` and `externalSideEffectProven:false` are preserved. It is **not** a durable file readback or independently proven OS effect.
- **Token revocation:** #569 mock WSS proxy proves fresh handshake with a revoked test credential is refused after isolated disconnect. **Already-open socket invalidation remains unproven.**
- **Journal durability:** Existing isolated WAL/tombstone/restart tests exercised as part of the 90-test run. They are not production backup/restore or anti-rollback certification.

## Separate additive adapter under review

`src/operations/agent-connection-journal-reconciliation.ts` is a **new**, fail-closed adapter. It does not edit #547/#569's transport code, existing Journal storage, or existing reconciliation helper. It requires:
1. Exact Hub operation UUID, target/device ID, capability, payload and optional provider ID with a stored, matching Hub fingerprint.
2. An `authenticatedDeviceId` obtained exclusively from the trusted exact-device route, **never** from the returned Agent JSON or an untrusted client field.
3. An Agent record matching that UUID, capability, and the independently calculated Agent fingerprint.
4. Online/availability checks and explicit evidence interpretation.

If provenance is missing or contradictory, result is `unknown`, no automatic retry. Even a matching terminal record has `externalSideEffectProven:false`.

**Critical limitation:** This adapter is intentionally NOT wired into the production MCP/Hub runtime. It is acceptance scaffolding to demonstrate a missing cross-boundary device-binding check. A production caller must first furnish authenticated route identity and a read-only Journal status response under owner/device authorization; absence of this integration is a release blocker, not a staging PASS. The existing `reconcileAgentOperation` remains conservative but does not itself compare device IDs.

## Matrix

| Scenario | Source/staging | Deployed physical acceptance |
| --- | --- | --- |
| Both devices reachable via authenticated native Agent route | Fresh read-only observations PASS | Connectivity PASS only, no continuity guarantee |
| Reconnect epoch / stale response and event | Isolated regression PASS | BLOCKED: no running upgraded Hub/Agent version provenance |
| Two simultaneous WebSockets for same device | Synthetic fencing PASS | BLOCKED: no production fault injection |
| Read-only bounded reconnect, original requestId | Synthetic PASS | BLOCKED: no real outage/reconnect |
| Mutation lost ACK / same requestId across reconnect | Disposable SQLite/WSS test PASS | BLOCKED: no real staged end-to-end cutover |
| Wrong authenticated device / cross-owner journal | New adapter test PASS | BLOCKED: adapter not wired to authenticated status retrieval |
| Fresh token revoked before re-handshake | Local persisted test credential PASS | BLOCKED: live revocation not performed |
| Revoke an already established WSS session | NOT VERIFIED | BLOCKED, S2 Public WSS scope |
| Agent terminal record vs actual file/service/process state | Metadata classification PASS | BLOCKED: no independently verified physical postcondition |
| Journal rollback / backup restore / durable monotonic anti-replay | Partial existing staging regression | BLOCKED: separate Journal v2 owner |
| Physical cable/Wi-Fi/tunnel failure and restoration | NOT RUN | BLOCKED until owner-approved test window + rollback channel |

## Reproduction

Run from the exact worktree at the new PR HEAD with Node dependencies installed:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
node --test --import tsx test/connection-journal-reconciliation.test.ts
node --test --import tsx test/connection-fault-proxy.e2e.test.ts test/connection-recovery-faults.test.ts test/native-session-continuity.test.ts test/agent-operation-reconciliation.test.ts test/agent-operation-wal-integrity.test.ts test/agent-operation-status.test.ts
```

The broader 16-module targeted suite returned 90 PASS, zero FAIL/SKIP.
Earlier full local Windows suites had failures outside this narrow scope, including #553-associated `D:\Temp`/path-policy, Windows Job helper/ACL, TLS fixture, test worker and GUI/desktop tests. **A new full-suite PASS is not claimed.** Do not weaken file security or rewrite #553 in this branch.

## Release blockers and ownership

1. Exact-head GitHub CI for this standalone DRAFT PR, including Linux/Windows/WSL/macOS tests.
2. Security review of device provenance and Hub/Agent hash ownership before any runtime wiring. No route identity may be accepted from caller-supplied JSON.
3. S2 signed public WSS: active-session token/owner/device revocation and bounded termination proof.
4. Journal v2: monotonic anti-rollback authority, restore/restart and durable outcome reconciliation across real failures.
5. Signed release/deployed SHA evidence for both physical devices, then owner-approved non-disruptive proxy staging and physical fault acceptance. The currently connected Agents advertise **1.0.5** and cannot be assumed to contain merged source.
6. Independently proven OS state for side-effect claims, not only RPC `ok`, shell exit code or journal succeeded metadata.

No real production mutation, token revocation, DNS, firewall, Tailscale, Cloudflare or service changes were performed.
