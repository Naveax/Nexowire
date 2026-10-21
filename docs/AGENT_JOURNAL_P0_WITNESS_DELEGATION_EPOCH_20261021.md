# #01 P0 #587, 21 October 2026: external atomic reserve provenance + CORE/ROOT delegation epochs

**Source-only stacked child of #614** at GitHub head
`ef1e3b23b01300e5f3bfe3769701b5b1446db5bd`, exact-head CI
`39598693419` **SUCCESS** (verified from Actions). #607/#582 are
parents; no shared Windows Job / ProcessManager #03 files were modified.
Work PC and Naveax both still report Agent **1.0.5**. No live SQLite,
Broker/Agent restart, privilege escalation, or production network resource
was changed.

## Step 1. Actual external CAS provenance vs synthetic PostgreSQL

- `PostgresMonotonicWitness` in #614 uses PostgreSQL `BEGIN`, enrolled
  device `SELECT FOR UPDATE`, globally unique request ID and the locked
  `witness_clock` row to serialize committed reservations. It is a real SQL
  algorithm/source, but tests use `WitnessPgPool` backed by an **in-memory
  SQL contract simulator**. This is **NOT** proof of running PostgreSQL.
- Existing #607 gateway tests exercise real isolated HTTPS and SQLite
  cache plus Map witness. The Map lives in the test harness and is **NOT**
  a rollback-independent production authority.
- Ed25519 signature verification in #614 uses real Node crypto, but signed
  *claims* of independent operation do not attest an actual remote host,
  immutable backup retention or physical rollback protection.
- No independently operated, authenticated remote PostgreSQL service,
  immutable high-water witness, rollback-external archive, trusted admin
  boundary, physical two-machine canary or real `pg.Pool` integration has
  been verified. **#587 remains P0 OPEN, production NO-GO.**

## Step 2. Owner/device/session/CORE/ROOT source integration contract

New additive `PostgresWitnessDelegation` with
`sql/agent-witness-delegation.sql`, isolated from Agent runtime:

- One persistent row per enrolled `device_id`: `owner_id`, device
  `epoch`, **session epoch**, generation (CAS), `core_enabled`,
  `root_expires_ms`, and `max_seen_ms`. Never store user commands,
  parameters, tokens, secrets, stdout or stderr.
- Every transition requires externally attested witness provenance,
  a verified owner+device enrollment, verified **session**, a signed
  short-lived operator grant binding exact action/owner/device/device
  epoch/session epoch/expected generation, and PostgreSQL row locks.
  An unrecognized/replayed grant cannot simply re-enable permissions.
- **CORE:** remains enrolled until explicit revoke/re-pair. A verified
  owner-approved session rotation preserves CORE, while the old session
  epoch is rejected. This is a *witness entitlement record*, not proof
  of an effective elevated Windows token.
- **ROOT:** a fresh signed grant yields exactly **900,000 milliseconds**
  from the witness server clock; expires without any background timer.
  ROOT-only falls back to NONE; ROOT with CORE falls back to CORE.
  Another 15 minutes requires a new signed grant with current generation.
- **Revoke:** atomically clears ROOT and CORE and advances generation;
  previous signed grants with stale generation cannot resurrect permissions.
- **Re-pair:** a signed owner authorization updates enrolled device owner
  and device epoch together with witness delegation row in **one
  transaction**, rotates session epoch, clears CORE/ROOT and bumps both
  generations. Historic global request-ID tombstones remain reserved.
- **Clock rollback:** `max_seen_ms` protects against the database clock
  moving backward within this witness generation. It does **not** detect
  rollback of the entire witness snapshot, including this high-water mark.
- Lost commit acknowledgement, disk-full, detached witness, untrusted
  session, missing signature/provenance are **fail closed** and must
  never trigger automatic replay of an UNKNOWN side effect.
- Runtime native Agent/Broker integration is NOT performed in this child.
  Particularly, witness preference `CORE`/`ROOT` is not proof of OS
  effective authorization, protected elevated helper, ACL or consent.
  Owner of elevated Windows helper integration must require independent
  proof; it must not infer effective privilege from frontend state.
- Existing older `migrateOwnerEpoch()` in #614 updates the device table
  alone. That deliberately fences the old delegation, and **does not
  automatically confer old CORE to a newly enrolled owner**. Use the
  atomic witness re-pair workflow after separate review.

## Step 3. Reproducible source evidence

`test/witness-delegation.test.ts` uses a deterministic, explicit **SQL
contract simulator** with serialized transactions, real Node
Ed25519 operator signatures (through the existing verifier), artificial
witness server time and fault injections.

Cases: no automatic entitlement, permanent CORE across fixture restart,
verified session rotation, ROOT exact 15-minute expiration, ROOT-only
expiry to NONE, server clock rewind, simultaneous generation CAS, owner
and device scope, revoke, old operator grant replay, re-pair clearing
both modes, wrong session, missing provenance, disk-full rollback, lost
COMMIT ACK and **rollback of witness storage itself**. Last case
demonstrates that a snapshot rollback can restore obsolete permissions;
that test PASS is **not** release safety acceptance.

The 20 tests combining new delegation, existing PostgreSQL contract and
Ed25519 tests PASS locally after final code changes. All earlier
Agent Journal v2 and HTTPS CAS tests remain untouched. CI must run at the
**published exact commit SHA** before any green assertion.

## Step 4. Physical threat model and safe migration

| Threat | Source result | Production gate |
| --- | --- | --- |
| Agent journal/WAL/local DB + Hub rollback | Prior #607 CAS preserves original UUID outside snapshot | Independently protected remote CAS |
| Revoke then stale local CORE preference restored | Owner delegation generation and session epoch reject old grant | Trusted remote entitlement readback and real Broker proof |
| ROOT expired across restart | Witness DB server clock denies after 900000 ms | Trusted server clock; time skew/jump physical test |
| Lost CAS commit ACK / disk full | No confirmed mutation grant; no blind replay | Real PG power-loss/ENOSPC and two-host test |
| Compromised old device/owner token | Enrollment and epoch verification fails after revoke/re-pair | Revocation, session identity and hardware-bound device credentials |
| Re-pair and owner migration race | Atomic conditional transaction prevents divergent device and entitlement | Real PostgreSQL concurrency test |
| **Witness itself rolled back** | **Old UUID or CORE could reappear** in old snapshot | Non-co-restorable authority and independently protected watermark, NO-GO |
| Signed but false provenance claim | Signature proves signer, not physical separation | Independent custody/restore attestation and audit |

**Pre-cutover migration:** freeze mutating operations, gather authoritative
historical request IDs/UNKNOWN and owner/device bindings read-only, verify
owner signoff with separate trust provenance, store/fence all historical
tombstones at the external authority, perform atomic epoch migration,
re-enroll sessions, revoke old tokens and compare trusted readbacks. Missing
or contradictory evidence fails closed. Never adopt a fresh empty authority,
drop old tombstones or issue another requestId to conceal UNKNOWN.

**Release blockers:** actual PostgreSQL service with durable atomic CAS and
independent rollback-external witness, protected signed operator grant
service, auth/session binding to an effective elevated Broker, real Windows
ACL/WAL/failure verification, and two physical device canary. No Cloudflare
DO/D1 or paid staging resources were started because none were authorized.
No #03 Windows Job code edits. **#587 production NO-GO**.
