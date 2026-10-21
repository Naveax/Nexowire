# NEXOWIRE P0 #18 follow-on, hostile cross-Hub migration and WAL (2026-10-21)

**Review-only and production NO-GO.** This work is an isolated QA child of
[PR #637](https://github.com/Naveax/Nexowire/pull/637) at verified parent
commit \`474838810ecce774f6e38ddbcd14c803fe9c1c5a\` and its successful
[CI run 39625291153](https://github.com/Naveax/Nexowire/actions/runs/39625291153).
#637 is itself stacked on DRAFT #631 / #614 / #607. Issue #587 stays OPEN.

## Scope and explicit trust boundaries

Only test and documentation files are added. The owner (#01) implementation
in \`src/agent/postgres-monotonic-witness.ts\`,
\`src/agent/witness-delegation.ts\`,
\`src/agent/witness-signed-provenance.ts\`, SQL migrations and main are not
modified. No real Agent, Broker, UAC, ACL, VM, live Hub/service, external
DB, production SQLite or ReVoltVPN-Ubuntu-Lab may be touched.

Two source-level \`PostgresMonotonicWitness\` instances and two
\`PostgresWitnessDelegation\` instances exercise real imported #01
TypeScript algorithms but share ONE serialized **in-memory SQL contract
simulator**. An explicit \`pauseNextConnection()\` gate lets an operation
authenticate its old principal, stop before SQL transaction entry, then
re-enter after another Hub commits revoke or signed re-pair. This is
deterministic schedule coverage, **NOT** actual two-process, two-host or
PostgreSQL transaction contention. Real \`pg.Pool\`, external storage,
network partitions and physical remote monotonic authority remain
**UNAVAILABLE / NOT RUN**.

The Ed25519 grant and provenance checks use real Node crypto with
ephemeral TEST ONLY signing keys. A verified signature proves a statement
was signed by the fixture key. It does NOT independently verify the remote
host's backup controls, retention, witness key custody, or protection from
restoring both authority and immutable high-water records together.

## Independent hostile acceptance matrix

| Case | Required source observable | Evidence boundary |
| --- | --- | --- |
| Old reserved UUID / restored Hub A journal followed by signed re-pair | Old owner fenced, new epoch gets \`WITNESS_REQUEST_ID_REUSED\`, tombstone retained | In-memory CAS |
| Hub A pre-authenticates an old epoch then pauses before SQL; Hub B signs re-pair | Hub A transaction rejects old owner/epoch, never inserts UUID | Deterministic simulated interleaving |
| Hub A authorizes stale CORE read but pauses; Hub B revokes at new generation | Hub A reads NONE; old signed grant cannot resurrect CORE | Same-process simulated contention |
| Two signed but competing re-pair grants for one device/generation | Exactly one valid owner/device/session epoch and cleared CORE/ROOT; historical UUID preserved | SQL transaction simulator |
| Two Hub objects, 32 historical collisions and 32 fresh duplicates after re-pair | Historical UUID fails globally, fresh ID has exactly one created winner | Synthetic shared witness |
| Re-pair COMMIT applies but ACK lost | UNKNOWN, no implicit retry; new epoch exists, historical UUID and revoked CORE remain | Fault injection, not real PG |
| **NEGATIVE: witness itself co-rolled back after revoke + re-pair** | **UNSAFE: revoked CORE resurrects and previously reserved UUID is accepted again** | Deliberate physical release blocker, not safety PASS |
| SQL simulator unavailable | Fail closed with explicit unavailable errors; no local authorization fallback | Not remote PG outage proof |
| Disposable Node child exits during real TEMP SQLite WAL writes after dispatch marker | Restart makes \`in_progress\` => UNKNOWN, external synthetic witness returns \`created:false\`; never dispatch again | **Actual local TEMP SQLite WAL**, not live Agent |
| Corrupt real TEMP SQLite WAL magic after child crash | WAL validator and journal startup reject; external tombstone still denies replay | Actual local TEMP WAL corruption |

All tests must be verified on the **exact published child commit SHA**.
CI green is not sufficient to claim production integrity or actual
monotonic CAS. No false \`PG SUCCESS\` or \`physical Agent success\` is allowed.

## Remaining release blockers

1. Authorized, independently administered **real PostgreSQL** with
   atomic create-if-absent under two truly separate Hubs; real
   transactions, WAL, fsync, restore and crash experiments.
2. Out-of-band independently retained high-water / tombstone authority
   that survives co-rollback of Agent, Hub, gateway and PG witness.
3. Proven external owner/delegation signing identity, secure key custody,
   physical re-pair/revoke and migration of historical Agent 1.0.5 UNKNOWN
   request IDs before any cutover.
4. Signed Windows high-integrity Broker validation, session/CORE epoch
   enforcement at actual dispatch and two physical device canaries.
5. Production mutation **BLOCKED** until #587 acceptance criteria
   independently verified. Never automatically replay UNKNOWN.

No command payload, credentials, tokens, stdout/stderr, user-file content,
live database connection or elevated Windows operation is recorded by
this fixture.
