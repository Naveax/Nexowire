# Durable Broker dispatch server component

`PostgresBrokerDispatchAuthority` implements the server-side external dispatch
interface using actual PostgreSQL transactions. It composes with
`createBrokerDispatchAuthorityHandler`, the existing HTTPS client and the
Broker dispatch fence. It is not installed, automatically started or enabled
in the Agent, Worker or production Broker. It does not provision grants.

## Atomic storage and credentials

Apply `sql/core-broker-dispatch-authority.sql` only on an authorized, separately
operated database. Explicitly provision the authority and authenticated native
enrollment/grant using a different operator identity. The runtime role must be
separate from the schema/table owner and must have only the documented grants.
Every transaction rejects a superuser, privileged/restore role, schema creator,
history deletion/truncation capability, grant provisioning or owner rewrite.

The protected pool accepts separate host/database/user/password, verified CA,
client certificate and client private key. TLS peer-name verification, TLS 1.3
minimum and channel binding are mandatory. Connection URLs and sslmode overrides
are not accepted. No credential, certificate or signing key is generated,
printed or defaulted for a real deployment. The signing key must be independently
protected; its presence in source configuration is not evidence of custody.

Authority and grant row locks serialize reserve, commit, release and revoke.
All statements in one transaction use one checked-out connection. A global
request UUID tombstone is persisted before acknowledging reserve; duplicate
begin or commit rejects, even with a fresh nonce or reconstructed service.
The original request, nested scope, Broker identity and reserve data cannot be
rewritten or deleted by ordinary SQL. A lost COMMIT acknowledgement destroys
the connection and returns UNKNOWN; the transaction/effect is never retried.

Each admission requires independently supplied current protected Broker readback
and an unexpired provenance/restore gate, repeated while holding the grant lock.
Caller booleans are not read as authorization. ROOT receipts cannot outlive
the grant's actual expiry. The DB clock cannot go behind the durable maximum.
WAL fsync/full-page writes, synchronous commit and primary state are checked.

Revoke first persists REVOKING and advances generation, disabling both CORE and
ROOT. It then waits a bounded time outside that initial transaction. Neither
an empty ledger nor a receipt timeout proves processes stopped: a separate
native drain verifier must confirm. Timeout, absent drain proof or lost ACK
keeps the device fenced; no automatic reactivation or replay is implemented.
Release remains bound to the full original claim after revocation and retains
the UUID history. Runtime credentials must support that scoped settlement.

## Evidence boundary and remaining real work

PostgreSQL/WAL/UNIQUE and this schema do not resist an administrator restoring
the authority database. An actual independent restore controller, hosting and
key custody must be provisioned and accepted. Do not implement provenance or
native Broker/drain callbacks as unconditional true in production. The native
approval service, owner-SID provisioning, protected installed publisher chain,
real HIGH/token/ACL and physical two-device acceptance remain prerequisites.

The dedicated Linux CI steps use the official PostgreSQL 18 container and
separate migration/runtime roles. They exercise real transactions, twenty
competing reservations, scope/replay/history failures, lost begin/commit ACK,
revoke/drain UNKNOWN, ROOT expiry and real HTTPS fence/client/handler dispatch.
An additional seed -> actual disposable PostgreSQL container restart -> verify
sequence checks server start time and retention of the original UUID tombstone.
Only that CI job's test container is restarted. Native HIGH, provenance, owner
approval and drain in these tests are explicitly synthetic; their success is
not production CAS independence, Windows containment or physical approval.

Local unit/contract tests and SQL syntax checks are separate from the real
PostgreSQL CI result. The local execution container maps only UID 0 and cannot
run a normal non-root PostgreSQL server; no UID or sandbox guard is bypassed.
Until the new exact-head CI completes, real PostgreSQL integration is pending.

No main merge, live installation/deployment, Agent/Broker restart, UAC, ACL,
credential or device/VM modification is performed. CORE stays disabled.

Primary implementation references:
- https://www.postgresql.org/docs/current/explicit-locking.html
- https://www.postgresql.org/docs/current/runtime-config-wal.html
- https://node-postgres.com/features/transactions
- https://node-postgres.com/features/ssl
