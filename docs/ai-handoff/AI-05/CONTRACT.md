# AI-05 Immutable external CAS and executor contract

## Admission identity

The original request identity is the exact validated `deviceId`, `epoch`, `requestId`, `fingerprint` and `capability`. In the PostgreSQL-bound CAS, authenticated owner/device/session/epoch/generation/requiredPrivilege is copied from plain own enumerable data descriptors and frozen before async SQL. The external reservation receipt, including `created` and `sequence`, is separately validated, detached and frozen before another SQL await. A remote returned object may not retroactively turn a historical `created:false` into `created:true`.

No reflected/accessor, Proxy, symbol, hidden, inherited or unexpected identity key is admission. Only primitive typed fields from a strict schema are accepted. `Object.freeze` and local SQL locks are not cryptographic identity, OS privilege or externally operated anti-rollback proof.

## HTTPS transport and configuration

External reserve/revoke/re-pair requests are snapshotted from own enumerable data descriptors, strictly parsed and frozen **before** credential resolution or network awaits. Their original wire bytes retain the approved immutable request identity even when caller references mutate. Each client and witness adapter pins a detached configuration object in its constructor: authority ID, device/epoch, token or credential-provider reference, trusted CAS provider and pool are not retargeted by the caller later.

Network uncertainty (timeout, lost ACK, HTTP 408/425/429/5xx, invalid or absent trustworthy admission) never authorizes a retry of a mutation. The transport has no internal mutation retry. Explicit HTTP 403/409 can count as refusal only where an independently operated server guarantees those outcomes were issued **before** any side-effect. Reconciliation of UNKNOWN must use an external durable request tombstone/OS observation, not a new invocation.

## Executor and Broker boundary

AI-05's approved executor callback must use the exact immutable payload bytes and fingerprint admitted by an independently protected Broker CAS fence. `CORE_EXECUTOR_DISPATCH_ENABLED=false` remains in source; no test fixture or signed JSON receipt enables it. AI-04 owns the separate Broker-side per-effect authorization and signed receipts. AI-07 owns OS worker launch/containment. The coordinator owns `src/agent/native-agent.ts`, `operation-journal.ts`, CI workflow and integration.

A valid `created:false` is **not** new execution permission. After lost ACK / restart / UNKNOWN no second mutation is allowed for the original UUID. No physical Windows/device/kernel authorization is claimed by this source-only PR.
