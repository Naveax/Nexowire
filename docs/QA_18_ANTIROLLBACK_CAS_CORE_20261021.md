# Worker #18 independent hostile CAS / CORE journal acceptance (2026-10-21)

This is an **independent source-only, additive QA child** of DRAFT #631
(which is stacked on #614 / #607 / #582). Source base before this child:
\`4e0cb8f5a00deb7ca00352ff24350402936ba59c\`.
Parent main at assignment: \`754cc4364822be5fda528f54042fb22a84f19924\`.

## Scope and evidence classification

- \`test/qa-18-external-cas-hostile.test.ts\` directly imports the existing
  \`PostgresMonotonicWitness\`, \`PostgresWitnessDelegation\`,
  \`signedOperatorGrantVerifier\` and \`signedProvenanceVerifier\`, so the
  test invokes parent implementation, rather than a replacement policy model.
- All database I/O is a deterministic serialized **in-memory PostgreSQL
  SQL-contract emulator**, not PostgreSQL, not a remote rollback-independent
  authority, and not proof of durable WAL, unique constraints, transaction
  isolation, physical retention, fsync, power-loss survival or encryption.
- Ed25519 signing/verification is genuine Node crypto with ephemeral
  TEST-ONLY keys. Signed provenance asserts a claimed restore-domain
  separation; this cannot prove separation from physical rollback.
- This test does not use live Node Hub, Agent, Service, Browser, Windows
  broker/UAC/ACL, external DB, paid Cloudflare services, VM or network.
  ReVoltVPN-Ubuntu-Lab is never accessed.
- No changes to #01 owner's SQL, witness, delegation or signed-provenance
  implementation files. No merge to \`main\`.

## Hostile acceptance tests

| Attack | Required / interpreted result |
| --- | --- |
| 24 concurrent reservations, 2 Hub client instances, same request ID | One \`created:true\`, 23 existing receipts and one global sequence |
| Same UUID across two enrolled owners/devices, wrong epoch, changed fingerprint | Refuse UUID collision and misbound identity; tombstone unchanged |
| Forged witness Ed25519 signature (attested independence claim) | Reject provenance before reservation or entitlement evaluation |
| Local journal + gateway cache restored after historical reservations | Historical UUID stays reserved if witness persists; never \`created:true\` |
| Lost COMMIT acknowledgment | Caller gets UNKNOWN; later same UUID returns \`created:false\`, never automatic replay |
| Forged operator grant, stale session and revoked old CORE generation | Fail closed; old signature cannot resurrect entitlements |
| ROOT at +899999 ms and +900000 ms | ROOT until, not including, 900000; durable CORE survives verified session rotation |
| Re-pair with new owner/device epoch/session | Old scope fenced, CORE/ROOT cleared, no implicit elevation |
| Concurrent grant with same expected generation | Exactly one successful generation CAS |
| **Authoritative witness snapshot itself rolled backward** | **UNSAFE: historical UUID resurrects** in simulator. This is a release BLOCKER, not a security PASS |

## Physical proof ledger

| Gate | Status |
| --- | --- |
| Direct imported source contract / deterministic negative tests | Run under child PR CI; only exact SHA CI may be cited |
| Real external PostgreSQL transaction and two-host contention | **NOT RUN** |
| Independent custody of DB backups / immutable tombstones and watermark | **NOT PROVEN** |
| Fake provenance vs actual independently operated witness attestation | Signed claim verified; physical independence **NOT PROVEN** |
| Agent v1.0.5 historical UUID / UNKNOWN migration with owner authorization | **NOT DONE** |
| Physical Windows signed Broker CORE elevation, ROOT 15-minute revocation and UAC | **NOT RUN** |
| Multi-host disk corruption, power loss, WAL restore, enforced owner epoch | **NOT RUN** |
| Work PC + Naveax physical two-device canary | **NOT RUN** |

**P0 #587 stays OPEN; PRODUCTION MUTATION NO-GO.** A PostgreSQL table
with an external hostname, a local Map, DPAPI envelope, or signed claim
does not provide an anti-rollback guarantee if the witness trust root can
be restored in the same snapshot/backup domain. UNKNOWN mutation must
not be automatically replayed. Deployment needs independently verifiable
monotonic retention, trusted operator custody, and a real two-device canary.
