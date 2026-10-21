# 21 October 2026: P0 #587 monotonic witness contract, owner migration and rollback adversary

**Scope:** additive source-only work stacked on **DRAFT PR #607**, based on
`0c60d5ef01144e38cdf31afdf65044cb7ebff093`. Do not reopen #558/#567;
no Windows Job #576/#608 files are modified. Work PC and Naveax live Agents
remain v1.0.5. **No live SQLite, Agent, Hub, Broker, DNS or Cloudflare mutation.**

## Production architecture (design, not deployed)

`Agent (journal + optional local authority)` -> `authenticated HTTPS
reservation gateway` -> `MonotonicTrustRoot` -> `separately
owned PostgreSQL witness` -> `independently signed storage provenance +
immutable retention / rollback-independent operational anchor`.

`src/agent/postgres-monotonic-witness.ts` implements the executable
`MonotonicTrustRoot` interface over a standard PostgreSQL connection pool
interface (e.g. a separately installed and authorized `pg.Pool`). SQL
schema: `sql/agent-monotonic-witness.sql`. Existing gateway wiring from
#607 requires `trustRoot` on startup, so the new implementation can be
injected without changing native Agent/Hub or mutating production settings.
**No production PG cluster, account, installer or operator trust material has
been provisioned or confirmed. No real PG integration PASS is claimed.**

### Atomic request-id reservation

1. Verify an unexpired, scope-matched **independently signed** provenance
   declaration and independently authenticated device owner.
2. PostgreSQL `BEGIN`, `SELECT witness_devices ... FOR UPDATE`: only
   the currently enrolled **owner UUID, device UUID and exact epoch** in
   `active` state can reserve.
3. The `request_id` is **globally unique across all devices/owners/epochs**
   and is bound to SHA-256 fingerprint and capability. If an existing row
   matches the exact active identity and contents, return `created:false`;
   mismatches fail closed.
4. Lock/update the single `witness_clock` row inside the transaction,
   yielding a **strict commit-ordered global counter** (unlike PostgreSQL
   IDENTITY sequences, which can commit out of allocation order). Then
   atomically `INSERT ... ON CONFLICT (request_id) DO NOTHING
   RETURNING sequence`, and `COMMIT` before returning `created:true`.
   No source command, token, arguments, stdout/stderr or payload is stored.
5. If the commit acknowledgment is missing, result is UNKNOWN. The gateway
   must not dispatch. Re-querying the original UUID for diagnosis can reveal
   `created:false`; it does **not** authorize automatic re-execution.

### Owner/epoch migration, enrollment and restore

An independently signed, time-bounded operator grant is required for
explicit initial enrollment, owner/epoch migration and freezing. Migration
requires **expected old owner, old epoch, expected generation** and distinct
new epoch, in an atomic conditional UPDATE. Old epochs cannot reserve, and
GLOBAL request-ID tombstones stay permanently available after migration.
No self-enrollment, implicit owner transfer or recovery by resetting the
journal is allowed.

`src/agent/witness-signed-provenance.ts` verifies Ed25519 signatures over
exact action scope or witness deployment/rollback-domain attestation. It
pins an externally provisioned public key and rejects forged, expired,
long-lived, early or wrong-scope statements. A signed statement is evidence
of the operator's claim, **NOT physical proof that the statement is true**.

A restore of the Agent's journal, local authority, Hub and gateway cache
cannot make request IDs new if this external witness preserves its history.
However **restoring the PostgreSQL witness itself** to an older snapshot
would re-admit a previously committed ID. The new adversarial test proves
this *limitation* explicitly. Therefore production is **NO-GO** until
retention provenance and an independently protected monotonic trust anchor
are proven, enforced, monitored and restore-tested.

## Threat and test matrix

| Adversary / failure | Source expectation | Evidence |
| --- | --- | --- |
| Journal/WAL/local authority and gateway cache restored | External root retains historical UUID and denies dispatch | Existing #607 co-rollback tests |
| Same UUID concurrently submitted to the root | Only one `created:true`; duplicates retain same monotonic sequence | SQL contract simulator tests |
| Same UUID from a second device/owner/epoch | Global uniqueness, fail closed even after owner change | SQL contract simulator |
| Old owner/epoch or unsigned migration request | Deny and preserve reservations | CAS and signature tests |
| Owner-epoch migration with stale expected generation | Conditional UPDATE fails; never opens new epoch | CAS simulator |
| Token revoked, CAS missing, remote full | Fail closed; read-only diagnosis | Existing #607 native HTTPS tests |
| Unknown commit response after durable insert | No trusted success returned, no auto-replay | Lost-COMMIT-ACK simulator |
| Wrong, forged, expired or other-deployment attestation | Deny mutation | Real Ed25519 tests |
| Witness database itself restored | **Danger: historical ID can be admitted as new**; release BLOCKED | Explicit threat-model test |
| PostgreSQL actual SERIALIZABLE/READ COMMITTED contention or physical remote restore | **NOT TESTED** | Requires isolated authorized PostgreSQL deployment |

### Evidence limits

The `test/postgres-monotonic-witness.test.ts` transaction runner is an
**in-memory SQL contract simulator**, not a real PostgreSQL engine. It tests
the transaction state machine, owner/epoch fencing, atomic uniqueness,
concurrency interleavings, crash/ambiguous commit and simulated rollback,
but cannot establish PostgreSQL durability, WAL archiving, fsync/replication
or serializability. `test/witness-signed-provenance.test.ts` genuinely uses
Node Ed25519 signing/verification with ephemeral test keys.

The operational attestation must have a **separate issuance/custody
authority**. The source intentionally supplies no private production key or
magic deployment credentials. A user-writable environment variable,
signed blob copied inside the same restorable snapshot, or second SQLite
directory is **not** sufficient provenance. Actual operator grants must
be issued with protected signing keys and retained audit records.

## Release checklist: ALL OPEN / BLOCKING

1. Provision an **authorized isolated remote PostgreSQL witness** under
   separately controlled identity, backup authority, restore permissions,
   immutable audit/WAL retention, and monitoring. Test server restart,
   concurrent CAS, power loss, disk/full and PG restore; ensure no silent
   rebootstrap. No new paid Cloudflare DO/D1 resources were created.
2. Obtain independently verified non-co-restorable storage provenance,
   pinned owner key and approval path, and out-of-band monotonic high-water
   mark protection against old witness restores.
3. Reconcile pre-cutover Agent 1.0.5 UUIDs and UNKNOWN states without
   executing any mutation; issue an owner-approved new epoch only after
   exhaustive historical scope verification. Do not silently skip records.
4. Verify signed package, ACL/effective service identity, TLS rotation,
   revocation, exact owner/device binding and disaster recovery runbook.
5. Perform two *physical* Work PC/Naveax canary tests, independent evidence,
   staged rollout/rollback while preserving tombstones.
6. Parent PR #582 and child PR #607 are separate. #576/#608 own shared
   Windows Job fast-exit changes. This branch changes **no Job files**.
   Do not interpret source CI success as product security acceptance.

**Decision: P0 #587 remains OPEN, production NO-GO, no live Agent updates.**
