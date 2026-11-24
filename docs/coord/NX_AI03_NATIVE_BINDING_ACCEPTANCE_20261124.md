# AI-03 CORE native acceptance prerequisites

Exact review base: #1263 `dfb4e8a529a0cc87a502d2a01481799c5fa292e9`. The accepted stack and #1251 are not changed. This is a separate source-only follow-up.

## Why the hard stop is still false

- `src/agent/core-windows-mutation-dispatch.ts`: P0 hard stop is explicit. The external fence requires independent signed CAS begin/commit and current native HIGH/image/ACL evidence. The native callback boundary must still bind exact effect input.
- `src/agent/privileged-broker.ts` (blob `481b23c7ba0c9a7b3f5b879828d0fccb12428001`, runPrivilegedBroker lines 399–456): production startup binds localOwnerAdmission only in local-owner mode; no independent BrokerExternalEffectAdmission is constructed there. Configured bearer token and Running task do not prove external authority or grant.
- `src/agent/windows-core-console-provider.ts` (blob `8a3caa1c13c26099cd038463ea812f42f094b8d3`, factory lines 634–671): independent native consent is an explicit trusted service composition dependency. A UI approval or local-owner mode is not a substitute for that dependency.
- Existing PostgresBrokerDispatchAuthority, HttpsBrokerDispatchAuthority and native verifier adapters are implementation pieces, not proof of deployed independently authenticated trust domains, key custody, durable CAS, protected current SID/session/LUID, DPAPI owner/SYSTEM continuity or effect drain. Source-only tests do not satisfy the MISSING external atomic revoke/dispatch/native-effect gate.

## Implemented: readback object boundary

Before this patch, initial, post-commit and synchronous final Broker binding readbacks were directly dereferenced by validation. This could execute a getter or Proxy trap before the effect decision, and validation did not pin a single immutable object. All three points now reuse the descriptor-only JSON snapshot and reject noncanonical or out-of-contract objects, then compare the detached frozen exact binding. The expected eleven fields remain required, including epoch/generation, HIGH/image proof IDs and expiry. No sign/verify, nonce, epoch, deadline, reserve/commit, owner consent, or elevation condition is weakened. Async Promise assimilation of a top-level Proxy's then property precedes this boundary, and is not claimed prevented.

Tests cover initial/recent/immediate getter, Proxy, revoked Proxy, unexpected fields and detached immutable scope. A failed late readback may follow a remote consumed claim; the effect must stay denied and must not be retried. Production authority remains responsible for durable single-use tombstones.

## Physical and external-service acceptance outstanding

Keep CORE_EXECUTOR_DISPATCH_ENABLED=false. Do not enable a production callback on a test adapter, local SQLite or bearer. To close the missing gate, coordinator must identify the actually deployed independent authority/service, protected credential and verifier composition, authenticated Windows-native owner/session/token evidence, and independently controlled release/rollback acceptance. AI-09 is sole physical executor. Require fresh owner approval, protected PID/image and HIGH token readback, scoped native per-effect claim and readback, STOP/revoke/drain, lost ACK UNKNOWN without replay across restart, DPAPI continuity under actual identity and rollback negative evidence. A blocked/unknown prerequisite is not PASS.

No physical changes, no new provider pretending to supply native evidence, no flag activation, no protected provenance edit. Exact new source blobs require coordinator reconciliation; run matching child CI.
