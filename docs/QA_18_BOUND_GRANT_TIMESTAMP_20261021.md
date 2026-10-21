# #18 P0 independent hostile review: bound-grant CAS / signed timestamps
2026-10-21. **Source-only; DRAFT; no production acceptance.**

## Exact source cross-check

- Parent #676: \`b935a594a68c2ba3e043b0731e5eb6d01081fa07\`; hosted Actions \`39634099233\` SUCCESS.
- Existing #659: \`87425f98fef6b8beb1bdf3675cf51ecf86c91949\`; Actions \`39631464079\` SUCCESS.
- #676 already tests duplicate request IDs, local cache rollback, signed owner migration (synthetic approval), concurrent reserve/revoke (without a controlled remote-first pause), expiry by a simulated database clock and lost ACK. #659 exercises older witness/delegation classes rather than the new bound grant CAS and remote-first revoke coordinator.
- The additional #18 QA imports **actual** \`PostgresBoundGrantCas\`, \`WitnessRevokeCoordinator\`, \`signedOperatorGrantVerifier\`, and \`signedProvenanceVerifier\` from #676 and its parents. Only new \`test/fixtures/qa-18-bound-grant-hostile.ts\` and \`test/qa-18-bound-grant-crosshub-timestamp.test.ts\` are introduced.

## Test boundary: what this does *not* prove

- \`PgContractPool\` is a single-process serialized SQL-contract emulator, **not PostgreSQL**. \`FakeExternalAuthority\` is a **volatile Map**, NOT a physically separate, immutable, independent monotonic CAS and not two networked Hubs.
- Two *distinct instances* of \`PostgresBoundGrantCas\` invoke actual source logic against the synthetic shared state. A deterministic barrier freezes one reserve **inside synthetic external CAS** after local DB scope/row-lock checks; another owner coordinator commits a remote revoke before that reserve is resumed. It tests source order and fail-closed behavior, **not** actual multi-host durability/linearizability.
- New Ed25519 tests use generated ephemeral keys to verify invalid future, expired, overlong, altered and wrong-action signed operator grants. The coordinator's approval callback uses the genuine signature verifier, rather than #676's permissive test-only boolean stub. Other external test functions are still synthetic. No signed timestamp itself proves owner/custody or a non-restorable trust domain.
- No broker effective Windows high token, protected service image/ACL, ROOT UAC, live Agent/VM/DB, physical network, owner secret or production migration has been used. ReVoltVPN-Ubuntu-Lab is excluded.

## Independent adversarial acceptance matrix

| Probe | Source-level expected behavior |
| --- | --- |
| Hub A reserve paused inside remote CAS, Hub B signed coordinator revoke externally committed | Hub A refuses reserve with UNKNOWN, Hub B applies revoke; restored LOCAL PostgreSQL grant row still cannot reserve |
| 32 concurrent same-UUID reserves from 2 Hub objects, local rollback | Exactly one first external reservation, repeated UUID \`created:false\` |
| Signed owner/epoch/session re-pair then LOCAL PG restore under two Hubs | Stale prior epoch denied by retained external grant fence and tombstones |
| Forged external receipt \`grantGeneration\` | Reject receipt, no local confirmed mutation; durable remote UUID cannot be replayed |
| Future, expired, overlong, tampered signature or wrong action owner grant | Real Ed25519 verification rejects; external revoke is not called |
| Valid signed revoke then still-time-valid signed approval replay | Remote fence must reject; no re-enablement of CORE |
| Signed provenance issued in future, expired, overlong or forged signer | Verifier fails; valid current signature only verifies operator statement |

## Remaining P0 release gates

1. Actual independently operated rollback-external CAS with operator-approved storage custody, immutable retention and out-of-band authenticated high-water; verify restoring DB/WAL/VM snapshots cannot resurrect request IDs.
2. Real PostgreSQL isolation, row-lock behavior, commit loss, WAL fsync and crash tests under truly concurrent Hub hosts; staged independent physical two-device canary.
3. Trusted signing key custody, signed timestamp clock source / nonce replay handling, owner/device/session enrollment, migration of Agent 1.0.5 historical UNKNOWN/tombstones.
4. Signed protected elevated Broker/Windows token verification and dispatch-time remote grant epoch fence. Already dispatched effects require separate cancellation verification.

**#587 OPEN: production mutation NO-GO** irrespective of synthetic test green.
