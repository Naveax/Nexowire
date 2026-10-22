# NEXOWIRE #18 | Final authority CAS dispatch barrier contract

**Scope:** QA-only, isolated DRAFT. 22 October 2026. **P0 #587 OPEN / production NO-GO.**

## Exact ancestry and source-vs-physical boundary

- #712 current exact HEAD \`1d78a7a9174e91e3b6baaa1319a063917391a64f\`; exact hosted workflow \`39676838080\` **SUCCESS**.
- #747 independent QA exact HEAD \`13acf85b063cd87e5bcf7a43e4fb650f63a30f42\`; hosted workflow \`39735278263\` **SUCCESS**. Parent #731 NEGATIVE (pre-revoke valid permit, delayed delivery after another Hub has begun revoke) remains unmodified and intentionally UNSAFE.
- This child extends only #18 QA. Its in-memory \`SimulatedExternalCommitAuthority\` is **a proposed interface / contract model**. No #01 execution/Broker source code, #04 Access source, live Agent/DB/VM/UAC/ACL, hardware Broker or production external authority is modified. Source-test CI does NOT attest a separately operated, non-restorable monotonic CAS.
- The test deliberately uses \`hyperv.vm.start\` merely as a **string capability**. There is **no VM operation**.

## Proposed authority states and linearization requirements

| State/operation | Required atomic semantics | Release significance |
| --- | --- | --- |
| \`reserve(requestId, nonce, scope)\` | Atomically allocate one globally unique dispatchId, retain requestId tombstone, bind signed owner/device/session epochs, grant generation, broker identity, privilege, capability and fingerprint | **RESERVED is NOT permission to execute** |
| \`commitForDispatch(dispatchId, request scope)\` | Externally linearize with \`revoke-start\` on the **same remote authority**. Commit must be a single-use CAS from RESERVED to COMMITTED only while epoch/generation/owner still current and not revoking | Signed and verified commit receipt required at the native effect boundary; existing #712 does **NOT** implement this API |
| \`revokeAndDrain\`: revoke-start | Externally and durably advance a revocation-pending barrier. All later commits denied, including previously RESERVED, valid Ed25519 permits delivered late to another Hub | Native effects committed **before** revoke-start are already admitted and require actual cancellation/readback/drain; a local per-process flag is not sufficient |
| \`effect + independent readback\` | Bind witnessed immutable side-effect digest/outcome to exact requestId, dispatchId, scope, signing authority and commitment | Lost readback after possible effect means **MUTATION_STATE_UNKNOWN**, no blind replay/refund/completion |
| \`release + drain\` | Keep unresolved committed effects in durable quarantine; remote drain must not report a successful verified completion if readback was lost | Do not manufacture \`drained:true\` or \`COMPLETED_VERIFIED\` from lease release/transport ACK alone |

## Deterministic source negative/positive boundaries

1. **Revoke wins**: Hub A receives a valid #712 fresh challengeNonce-bound signed reserve permit and pauses immediately before the hypothetical native commit. Hub B starts a signed revoke, the external synthetic authority marks revocation pending, then Hub A attempts the final atomic commit. It is denied with \`TEST_FINAL_COMMIT_REVOKED_OR_STALE\`, no synthetic native effect occurs, reservation is released, drain completes and a new Hub cannot reuse the same request.
2. **Commit wins, but readback disappears**: Hub A atomically commits and verifies a synthetic Ed25519 dispatch-commit receipt, records exactly one synthetic side effect, then its independent outcome readback disappears while Hub B starts revocation. The client must surface \`MUTATION_STATE_UNKNOWN\` and never replay. The synthetic authority keeps an unresolved-commit tombstone; Hub B's drain is also \`DISPATCH_REVOKE_OUTCOME_UNKNOWN\`, not a fabricated \`drained:true\` success.
3. A successful test of this proposed harness is **not** proof that either production #712 or #741 implements this final guard. #741's native/readback layer remains review-only (\`elevatedDispatchAllowed:false\`).

## Non-negotiable physical acceptance

- Real separately administered, non-co-restorable monotonic storage and signed readback; genuine multi-Hub atomic CAS under crash/restart, WAL co-rollback and independent owner re-pair; durable requestId/dispatchId history.
- Protected signed actual Windows HIGH Broker PID/creation FILETIME, image/import/updater/ancestor ACL, guarded native effect boundary and revocation cancellation; #03/#04 physical ownership.
- Real side-effect digest/provenance readback and durable UNKNOWN quarantine, no replay. Pending readback must remain UNKNOWN even when effect might have happened.
- **No live VM, Agent, database, UAC or protected Broker was involved.** #587 remains **production NO-GO**.
