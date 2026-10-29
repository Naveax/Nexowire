# #01 P0 #587: externally atomic owner-grant reservations and revoke/re-pair reconciliation

**Scope:** Source-only owned implementation child of DRAFT #631
(`4e0cb8f5a00deb7ca00352ff24350402936ba59c`), above #614/#607/#582.
The independent #18 QA PR #637 (`474838810ecce774f6e38ddbcd14c803fe9c1c5a`)
has its own test and document files; this change does NOT modify them.
Both #631 and #637 had exact-head GitHub Actions **SUCCESS** verified before
starting. No live Agent/Hub/DB/VM was restarted or modified; #587 remains OPEN.

## The bug and why a signed owner grant cannot be accepted alone

Existing #614 `PostgresMonotonicWitness.reserve()` checks owner/device/epoch
and globally unique request IDs, but a **session/CORE/ROOT entitlement can
be revoked concurrently** with a reservation. Checking a previously signed
owner grant or making a status read before a subsequent write is insufficient
and can be replayed after journal/cache rollback. A signed declaration of
remote provenance likewise **cannot prove physical backup independence**.

## New concrete source integration

1. `src/agent/postgres-bound-grant-cas.ts` implements
   `PostgresBoundGrantCas implements MonotonicTrustRoot` with existing
   `WitnessPgPool` and `witness_devices`, `witness_delegations`,
   `witness_reservations`, `witness_clock` schema:
   - Scope is derived from **verified device/session credentials**, NEVER
     request body or restored UI state. The scope includes owner ID, device
     epoch, session epoch, expected delegation generation and required
     NORMAL/CORE/ROOT level.
   - PostgreSQL `BEGIN`, enrolled-device and delegation rows
     `SELECT ... FOR UPDATE`, DB clock and ROOT 900000ms expiry checks.
   - **Before local reservation**, call a separate `ExternalGrantCas`
     `reserveIfCurrent(request,scope)`. The *external service* must
     atomically compare current owner/device/session/generation/revoke
     state and reserve a globally unique request ID in rollback-external
     durable storage. It returns an exact typed receipt.
   - On external `created:false`, the local PostgreSQL database
     cannot turn it into `created:true`, even if its entire snapshot
     was rolled back. On remote UNKNOWN, malformed/mismatched receipt or
     local SQLITE_FULL, fail closed; never blindly retry or dispatch.
   - Normal PostgreSQL global request-ID cache/clock still use a single
     transaction with commit-ordered `witness_clock`, but the local
     sequence is **not the independent trust root**.
2. `src/agent/https-external-grant-cas.ts` is a real Node HTTPS client
   for `POST /v1/grant-cas/reserve`, `/revoke`, `/re-pair`. TLS hostname/CA
   verification is required; HTTP/URL credentials/redirects rejected,
   bounded deadline enforced, exact authority/owner/device/session/epoch/
   generation/request ID/hash/mode receipt validation. Device token comes
   only from a protected credential resolver, never command line/log.
   **No production external service is deployed by this PR**: its REST
   API contract must be implemented/attested by a separately authorized
   remote CAS owner.
3. `src/agent/witness-revoke-coordinator.ts` verifies an independently
   signed, scope-bound owner approval and verified old device/session
   before advancing **the external CAS fence first**. The remote root
   serializes competing reserve/revoke/re-pair actions. An acknowledged
   external revoke/re-pair is then materialized in local PostgreSQL
   with conditional old owner/device/session/generation CAS. If external
   changes revoke the old identity immediately, the local update uses
   the previously authenticated operator signature and **remote receipt**,
   not a second authentication of an already revoked credential.
   Local commit failure or lost acknowledgement is
   `TRANSITION_LOCAL_RECONCILIATION_REQUIRED`/UNKNOWN: no replay.
   Re-pair rotates owner, device epoch, session epoch, clears CORE/ROOT
   and preserves all historical remote requestId tombstones.

**Source integration boundary:** the existing `createIndependentCasHandler`
already accepts a pluggable `MonotonicTrustRoot`; injecting the new
`PostgresBoundGrantCas` is a supported source integration. The existing
native Agent v1.0.5 is NOT upgraded. This PR is a library/adapter and does
not configure protected OS broker/effective elevation or new cloud service.

## Reproducible negative tests and evidence classification

- `test/postgres-bound-grant-cas.integration.test.ts` imports the real
  implementation and transition coordinator but uses **serialized
  deterministic PostgreSQL SQL-contract simulation** and a clearly
  synthetic external CAS to control crashes and hostile interleavings.
  Tests: 24 simultaneous same requestId => one external `created:true`;
  revoke wins over restored PostgreSQL cache; old owner/device/session
  grant after signed revoke; remote success + local disk full; remote
  lost ACK; external revoke committed but local write failed; ROOT
  expiry; atomic re-pair; session/owner migration and old UUID reuse;
  concurrent reserve/revoke and revoke lost ACK after commit.
- `test/https-external-grant-cas.integration.test.ts` spins up an actual
  isolated **TLS** server with disposable certificate and transient
  in-memory handler. Verifies strict HTTPS receipt checking, duplicate
  reserve, forged session proof, revoke, and refusal to downgrade to HTTP.
- Previous #18 tests remain unchanged and independent. Existing #631
  Ed25519 signature tests are real crypto, and existing source-only
  journal/WAL/Hub/Agent regression tests remain part of validation.
- **These test doubles are not actual external rollback-independent
  authority or a real PostgreSQL instance.** A test PASS only proves
  source state transitions and transport validation, not durable
  physical isolation or operational privilege.

## Threats and release gates

| Threat | Source gate | Remaining physical proof |
| --- | --- | --- |
| Journal + local authority + PostgreSQL cache rollback | External CAS historical UUID is never new | Independent remote CAS, unalterable tombstones |
| Old signed CORE/ROOT grant after revoke | Independent external generation CAS and DB row locks | Actual credential custody, broker consumption of latest fence |
| Concurrent reserve vs revoke | External conditional atomic reserve/revoke order, not read-then-write | Multi-host CAS linearizability and dispatch-time revocation fence |
| Re-pair old owner/session | External generation advancement; conditional local apply clears CORE/ROOT | Real owner migration and signed 2-device canary |
| Lost external ACK after commit | UNKNOWN; never auto-replay | Real power/network failure tests |
| Local SQLITE_FULL after external grant | External tombstone retained; future duplicate blocks | Real remote + local volume/quota tests |
| **External root itself restored** | **UNSAFE without independent monotonic custody** | Strongly protected anchor/retention, NO-GO |
| Broker high-token execution after revoke | Not wired/attested by this PR | #03 signed helper/effective token + dispatch cancellation acceptance |

Atomic reservation permission alone cannot guarantee that an already
queued/running side effect will be stopped when a revoke occurs later.
The dispatching Windows Broker must revalidate the **current external
grant fence at dispatch time** and observe cancellation semantics;
this PR does not claim to implement that layer.

### Production NO-GO

Requires a separately administered actual remote CAS service supporting
atomic owner/device/session/versioned UUID reservation + revoke/re-pair;
evidence its storage cannot be jointly restored with Agent/Hub/gateway;
trustworthy owner/device/session enrollment and historical tombstone
migration; physical Windows signed Broker token/ACL/ROOT/CORE testing;
real two-device canary and verified restore exercises. No Cloudflare
DO/D1 staging and no live Agent/VM/service changes were performed.

**P0 #587 stays OPEN; DRAFT only; no UNKNOWN replay.**
