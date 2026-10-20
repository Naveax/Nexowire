# P0 #587: external mutation reservation boundary (2026-10-20)

**Status:** Source-only candidate in a child DRAFT PR of #582. Not production
accepted. Neither Work PC nor Naveax Agent 1.0.5 is upgraded/restarted.
This change preserves #558/#567 and existing journal/WAL/CAS logic.

## Why #582 is insufficient
A verified #587 negative test restores **both** local SQLite databases,
journal and "independent" local authority, to their previous consistent
snapshot. A historical request UUID is then returned as `created:true`.
Separate directories, SQLite FULL/WAL, and local epoch UUIDs provide no
rollback independence if the same image operator can restore both.

## New external boundary
The native Agent now requires **separately authenticated HTTPS CAS** for
every mutating request, before any local `begin()`, `markDispatched()`
or `executeCapability()`. It does **not** create a remote authority on
startup and does not trust the two local SQLite databases as a replay
authority. The external trusted **monotonic witness** owns an atomic durable unique
`(device_id,request_id)` tombstone across Agent/Hub restarts and Agent
volume restores. The server binds request to a configured per-device token
and epoch, persists only opaque request UUID, SHA-256 fingerprint, capability,
device UUID, epoch UUID, and monotonic sequence. No command/payload, tokens,
stdout, stderr or secret values are logged or stored in the CAS SQLite DB.

The CAS client requires HTTPS with verified TLS (Node trust store),
disables redirects, validates every typed response and exact configured
authority ID, device ID, epoch and request ID, and applies a bounded request
timeout. A reservation `created:false`, missing/invalid remote proof,
wrong credential/device/epoch/fingerprint, timeout, remote outage or disk-full
**does not dispatch**. A network acknowledgement lost after the server commit
also fails closed: next attempt is a remote duplicate, NOT an automatic retry.

**Read-only diagnostics remain available** when external CAS configuration is
missing: native Agent no longer aborts its entire boot because the previous
local SQLite authority variables are unset, and its journal is initialized
lazily only for actual writes or explicit journal-status read. Real isolated
native Agent test confirms `machine.snapshot` succeeds, while `files.write`
is denied and no target file exists.

Four required native runtime environment variables (no implicit defaults):
- `NEXOWIRE_AGENT_RESERVATION_CAS_URL` must point to the verified HTTPS
  `/v1/reservations` endpoint of the independent trust authority
- `NEXOWIRE_AGENT_RESERVATION_CAS_TOKEN` provisioned per device with
  securely protected runtime secrets (never put into command-line args)
- `NEXOWIRE_AGENT_RESERVATION_CAS_AUTHORITY_ID` trusted immutable UUID
- `NEXOWIRE_AGENT_RESERVATION_CAS_EPOCH` exact enrolled device epoch UUID

Legacy `NEXOWIRE_AGENT_JOURNAL_AUTHORITY_*` local SQLite variables remain
optional *secondary local consistency* checks from #582 but do **not**
substitute for external CAS. This is an incompatible operator rollout: no
CAS => no mutation, and no automatic migration/bootstrap.

## Reference CAS backend and negative evidence
`src/agent/remote-mutation-cas.ts` includes a separately provisioned
**reference gateway/cache** SQLite WAL/FULL CAS handler. From #587 onward
the handler requires a `MonotonicTrustRoot` implementation, and refuses
startup with `CAS_TRUST_ROOT_REQUIRED` if it has none. The witness must
atomically reserve the request ID **before** the gateway cache transaction.
A missing witness, invalid/scope-mismatched proof or timeout returns 503,
not a new local reservation. A witness refusal or duplicate may never be
overridden by the cache. `HttpsMonotonicTrustRoot` is an HTTPS adapter for
a separate enrolled monotonic service; it does not automatically manufacture
a durable service or trust provenance.
A successful external reservation followed by local `SQLITE_FULL` is
conservatively UNKNOWN to the Agent; replay remains denied by the witness.

**Negative #587 test:** rollback BOTH Agent-local databases and the remote
reference gateway SQLite cache, but preserve the test-only witness outside
these snapshots. The historical UUID still returns `created:false`.
Additional tests cover witness missing/403, malformed proof, wrong
device/epoch, corrupted remote WAL header, token rotation and HTTPS
witness adapter. The test-only witness is an in-memory Map in
`test/fixtures/`, **not production durability evidence**. The rollback
gateway handler uses a loopback, non-keepalive test transport while other
tests exercise real TLS and certificate verification. The production client
accepts HTTPS only.

Operator must explicitly provision a real external witness and the cache.
`createIndependentCasHandler` is a library entrypoint, not a standalone
production service. The backend needs a deployment with independently
verifiable immutable trust provenance and retention guarantees. Operator must explicitly call
`provisionIndependentCasDatabase()` once. Server refuses to create
missing/unprovisioned storage on process restart or after data loss.
Server must be hosted on a separately owned host/storage and reachable
only over properly issued and verified TLS. CI fixtures run real isolated
HTTPS with ephemeral CA and a physically distinct test directory, NOT
public production authority.

`test/agent-remote-cas.test.ts` runs a real TLS client/server and:
- Snapshot both local SQLite journal and local authority before UUID B,
  execute reservation B, rollback both old snapshots, and prove remote B
  stays committed and `created:false`; no side effect/replay is attempted
- Wrong device/epoch, wrong fingerprint/capability, rotated/revoked token
  and unchanged historical tombstone
- Remote offline, bounded disk via isolated SQLite max-page-count
  `SQLITE_FULL`, and missing server storage: fail closed
- Restart server on the *same remote durable DB* and check historical
  tombstones survive restart
- Only metadata, not payload or token fields in server DB schema

`test/agent-readonly-without-cas.test.ts` launches real Agent without CAS,
checks read-only snapshot and verifies mutation cannot create a file.
`test/agent-native-remote-cas-live.test.ts` launches real Agent with a
separately provisioned localhost HTTPS CAS, commits a disposable file
mutation with prior remote reservation, then disconnects CAS and proves
the next file mutation cannot execute.

Linux, macOS and first-party relay native-live CI fixtures explicitly
provision a *test-only* isolated CA/CAS, bind it to a deterministic disposable Agent identity, and
set the CAS variables for that child. This fixes their previous
`AGENT_AUTHORITY_CONFIGURATION_REQUIRED` failure **without bypassing the
native mutation guard**. Live production credentials are never used.

## Remaining security and physical acceptance gates
- **The monotonic witness must be deployed and authenticated in a separate
  rollback/backup/security domain.** The included gateway SQLite cache is
  explicitly **not** an independent trusted root and cannot itself detect a
  rollback of its **own** database. Operator
  must attest remote retention, immutable audit, restore policy, ACL/service
  identity, quorum/replication or real managed monotonic storage. Do not
  claim production anti-rollback from source HTTPS tests alone.
- Existing v1.0.5 historical request IDs predating remote CAS have not been
  enrolled into remote tombstone history. Proven exhaustive migration or
  a new authenticated epoch-aware issuance protocol must fence all
  pre-cutover IDs. No blind replay or fresh request ID to hide UNKNOWN.
- Local Agent identity can be copied with its credentials by an attacker
  with that access. Production device credential binding and revocation
  need real owner/TPM or protected service identity assurance.
- Verify real remote disk-full/host failure, owner/token rotation, TLS
  trust/pinning, power-loss durability, concurrent CAS requests, stale
  backup restore and two upgraded Agents/Hub on **separate physical devices**
  before production signoff. Never silently adopt a new empty CAS database.
- Windows Job fast-exit stdout drain failure on PR #582 exact head
  `0e322c94` was assigned to PR #576 owner in PR comments; #01 does not
  edit shared process-manager/Job code or delete/skip the failing test.
- CI exact-head success is independent of release acceptance; #587 remains
  BLOCKED until independent physical authority is attested.

`MUTATION_STATE_UNKNOWN` and absent/ambiguous CAS receipts are never
automatically replayed. Read-only reconciliation may inspect records.
