# NEXOWIRE #06, 2026-10-22: forensic UNKNOWN + protected owner epoch connection acceptance

**SOURCE-ONLY DRAFT. Production NO-GO.** No real Agent/Hub disconnect, VM, UAC, user-file mutation or #08 Artifact Store change.

## Exact reviewed upstream

| Reference | Exact HEAD | Evidence |
|---|---|---|
| PR #703 Connection baseline | `13cef903130d36a4b9c37aff571b80e273a2c87d` | CI `39658452754` SUCCESS |
| PR #725 Artifact forensic | `09c3dcaf23103b429780c2862c846956058bdcb8` | CI `39659633982` SUCCESS |
| PR #712 Broker owner epoch initial read | `62800af17d2a9ce18670dba6a8ac861a5d7f4ba5` | CI `39659225895` SUCCESS |
| PR #712 later moving HEAD | `1d78a7a9174e91e3b6baaa1319a063917391a64f` | CI `39676838080` running at review |

#725 `src/mcp/cross-device-transfer-jobs.ts` preserves `MUTATION_UNKNOWN` and typed `errorCode` e.g. `FORGED_WRITE_RECEIPT` after possibly dispatched writes, cancel, broken Native receipt and publish failure. #712 `src/agent/broker-external-dispatch-fence.ts` independently requires numeric ownerEpoch, grantGeneration, session/device identity and *fresh 32-byte nonce* in a signed external dispatch proof. Neither is the Connection numeric destination WSS epoch or the #616 worker lease epoch.

## Connection-only code

`src/mcp/cross-device-worker-journal-link.ts` adds a required `BrokerOwnerEpochAdmission` plus injected `BrokerOwnerEpochWitness.assertFresh` to a read-only worker-journal observer. It validates ownerEpoch and grantGeneration as positive safe integers, exact protected deviceEpoch/sessionEpoch UUIDs and CORE/ROOT privilege. It creates an **independent random 32-byte nonce before and after any awaited destination stage readback**, checking trusted owner/device and grant scope each time. A reused signed permit from restored WAL must fail independent fresh-nonce verification. Missing or rejecting owner authority => `authority_blocked`.

**Critical integration boundary:** #712's `beginIfCurrent` RESERVES an external dispatch claim. This read-only observer must **never** invoke that claim-allocation API merely for inspection; it needs a separate authenticated read-only proof backed by protected Broker/current external monotonic authority, or must fail closed. The present synthetic witness tests are not proof that such an API exists in production. Do not interpret a callback's boolean or a historical signature from the journal as secure attestation.

`FencedWorkerJournalSnapshot.errorCode?` is acknowledged as untrusted forensic metadata; the adapter neither erases it nor mistakes it for a permit. A correct stage readback yields only `readback_verified_not_committed`; it does not clear `MUTATION_UNKNOWN`, change bytesConfirmed or issue a write. Orphaned worker pending without matching Connection checkpoint returns `journal_mismatch`, never replays automatically.

A **double reconnect** increments the independently authenticated Broker socket epoch twice; the same pending requestId can only be re-observed under explicitly externally updated Connection checkpoint context, never via automatic resume or mutation retry. Independently check source/target devices, source SHA, chunk offset/size/hash, external worker lease epoch, owner grant generation, ROOT session epoch and live Broker socket epoch.

## Deterministic synthetic tests

New `test/connection-725-712-forensic-reconnect.test.ts` contains 7 cases: forensic errorCode plus pending UNKNOWN preserved; owner/grant-generation revoke *during* Promise-gated readback with distinct nonces; signed-claim replay and wrong owner/device/epoch; disposable SQLite WAL/FULL reopened journal with two reconnects and zero offset credit; orphaned pending after restart; cancel concurrent with grant revoke; and ROOT session epoch replacement during readback. No actual data upload, live Agent access or privileged dispatch.

Previously added #613/#666/#695/#703 tests remain in this stack, including pre-dispatch `pending.dispatched=false`, lost ACK unknown, invalid SHA, dead owner and wrong device.

## Executed local evidence

- **Own source worktree based on PR #703 exact head:** `npm run typecheck` PASS, `npm run build` PASS; **160/160 selected regression tests PASS** (25 source modules), including 7 new Connection cases.
- **#725 exact source HEAD overlay (only Connection source/tests):** typecheck/build PASS; **52/53 combined focused tests PASS, one inherited #08 `artifact-writer-fence-221k.test.ts` FAIL** due fixture terminal `COMPLETED` timeout. Same owner test executed alone **7/7 PASS**. Do not hide flaky/combined red and do not modify owner files.
- **#712 moving exact HEAD `1d78a7a...` overlay:** typecheck/build PASS, **42/42 Connection tests PASS**. Combined run including two #01-owned suites **43/45 PASS, 2 FAIL** locally for environment reasons: Windows Node22.14 `node:sqlite` lacks `backup` export and OpenSSL CLI TLS fixture generation failed. Neither error came from Connection tests; #712 current HEAD hosted status must be verified independently.

## Blocking production integration

#00/#01/#08 must implement trusted fresh read-only Broker owner-epoch proof without allocating dispatch claims, plus real independent monotonic CAS, validated signed Native write receipt, atomic #08 worker receipt vs Connection checkpoint coordination, and authenticated destination data readback/publish proof. Physical Agent v1.0.5 does not attest this code. UNKNOWN can never be made safely replayable merely by a signed-looking ACK or local SQLite snapshot.

No #08 Store, Agent binaries, OS registry/services, elevated tokens, live network, VM, or user data touched.
