# NEXOWIRE #18 | independent cross-Broker revokeAndDrain, rollback and permit QA
21 October 2026. **SOURCE-ONLY. DRAFT. P0 #587 PRODUCTION NO-GO.**

## Provenance / exact dependencies

- Target owner #01 PR #702 exact HEAD \`576eab8926c8257c13a47fa1be806554e2ecd190\`, GitHub Actions run \`39646460335\` **SUCCESS**.
- Previous independent #18 PR #680 exact HEAD \`901d6d34708b2181a016075e14251656d3b34f36\`, exact SHA CI **SUCCESS**.
- This child uses PR #702 **as its base**, touches NO #01 production code, and adds only \`test/qa-18-broker-revoke-drain-hostile.test.ts\` and this documentation.
- \`BrokerExternalDispatchFence\` and \`signedOperatorGrantVerifier\` are imported from real owner source. Test cryptography is actual ephemeral Ed25519; the protected high token, identity, Windows broker, REST authority, and remote atomicity are **synthetic callbacks/test objects**.
- All fixture timestamps/UUIDs, SQLite files and signing keys are disposable. No live Agent/DB/Hub/UAC/VM, high-privilege action, production token, physical user file, paid service or ReVoltVPN-Ubuntu-Lab interaction.

## Adversarial matrix, independent of owner #702 tests

| Fixture | What is verified in the source test | Meaning |
| --- | --- | --- |
| Two distinct Broker gate objects, admitted effect and concurrent revokeAndDrain | External synthetic drain blocks until release; pending/new claims denied across both local gate instances | Tests in-memory ordering, not actual multi-host external linearizability |
| Paused beginIfCurrent vs remote revoke | Revoke advances generation before deferred begin resumes; execute callback never runs | Test-controlled race |
| Stalled remote revoke from Broker A vs claim from Broker B | B is denied despite no local fence; A remains fail closed | Cross-instance negative |
| Revoke actually committed, ACK lost | Returned UNKNOWN, no new dispatch even by a fresh Broker instance | Synthetic external state survives within fixture |
| Signed owner/device/session re-pair | Synthetic remote owner/session/epoch/generation transition fences old owner; CORE remains disabled for replacement | #702 has no independent re-pair endpoint, so this transition is explicitly modeled, NOT production implementation |
| Historical UUID across Broker objects | Exactly one signed external claim, second gate denied | Remote tombstone required |
| **NEGATIVE**: same authentic signed dispatch permit replayed by a dishonest remote service to a distinct gate | Both can invoke the injected callback on the SAME UUID, because gate's \`claimed\` Set is process-local | Demonstrates need for externally atomic globally single-use permits; test PASS is UNSAFE, **not** a security guarantee |
| Real test-only SQLite WAL + backup rollback | Local \`active=1\` resurrects; new gate obtains online proof and remote revocation denies dispatch | Actual disposable local SQLite only |
| **NEGATIVE**: authoritative external CAS rollback | Revoked generation resurrects and dispatch becomes possible | Intentional P0 release blocker; physically non-restorable witness NOT DEPLOYED |
| Lost release ACK after callback | Initial gate closes, a new gate may receive a *different* permit for a different UUID in simplified synthetic model | Remote pending-lease and external postcondition evidence mandatory; not proof of exactly-once effects |

**Critical boundary:** The model uses one in-memory JS object as a serialized external authority shared by two gate instances. It does not create two real Hub processes or a remote authority. A synthetic signed permit or \`drained:true\` receipt cannot demonstrate physical monotonic persistence, Windows high token, live protected ACLs or cancel of an already executing operation. Even real Ed25519 validity does not prove the authority retained a single-use tombstone after crash or backup restore.

## Release and owner hand-off

1. #01: deploy/attest a separately administered rollback-external CAS with immutable globally unique requestId and dispatchId, atomic owner/device/session/CORE/revoke generations and stale-request quarantine. Require actual remote revokeAndDrain with bounded and auditable pending leases; witness must survive co-rollback of Hub/Agent/PG and itself.
2. #03/#04: independently verify actual protected signed Windows Broker binary/imports/updater ACL, high token and dispatch-time owner/epoch fencing with cancellation/UNKNOWN readback. This QA does not modify their files.
3. Replay negative must never be normalized to a "green security gate": both signed-claim and external-witness co-rollback NEGATIVE fixtures deliberately surface source/physical dependencies.
4. No automatic retry of UNKNOWN dispatch or revoke. No main merge or production activation until issue #587 has separately attested physical acceptance evidence.

## CI rule

Cite the GitHub Actions run by **this child SHA**, not #702/#680 successes. A cancelled/queued/failed hosted job is not PASS. Do not rerun identical SHA merely to obtain a different screenshot.
