# AI-05 Immutable CAS admission contract

## Authority and trust boundary
The caller-provided `CasRequest` (UUID, fingerprint, capability and device epoch) is validated, **cloned and frozen synchronously** when `PostgresBoundGrantCas.reserve` starts. The resolver's returned `AuthenticatedGrantScope` (ownerId, deviceId, deviceEpoch, sessionEpoch, expectedGeneration, requiredPrivilege) is not retained as a borrowed reference. It is examined by property descriptors without invoking getters, structurally validated, copied and frozen **before** any SQL BEGIN/FOR UPDATE or external CAS call.

An `ExternalGrantCasReceipt` is separately checked for plain own data descriptors, fully schema-validated, detached and frozen before the next SQL await. In particular `created:false` and sequence cannot be rotated by a retained provider object after validation.

The local PostgreSQL device/delegation row locks do not replace the independently operated, rollback-resistant external reserve/commit gate. The external `reserveIfCurrent` provider must bind the identical immutable request and scope to an atomic current grant/revoke generation and global UUID tombstone. `created:false` is a replay-denial/readback result, **never** a new execution permit. If external reservation may have committed but its acknowledgement was lost, the result is UNKNOWN, no silent retry or local fallback.

## Invariants tested
- Owner/session/generation can mutate in the original resolver object after row checks without changing external CAS request, authorized scope or stored tombstone owner.
- Original caller request UUID/fingerprint can mutate during SQL awaits without rotating the reserved identity.
- Accessor-backed scope inputs fail closed without invoking a user getter.
- Lost external acknowledgement triggers one external attempt and database rollback, not a second mutation.
- Previously tombstoned global UUID remains `created:false`, with no fresh insert, even if the borrowed external receipt is changed after its initial proof check.
- Accessor-backed external proof is rejected without running a getter.

## Integration boundaries
AI-04 owns Broker admission, signed effect receipts, Job/kernel readback, and the existing `broker-external-dispatch-fence.ts`. AI-05 owns the CAS and executor modules only. The coordinator owns `native-agent.ts`, `operation-journal.ts`, shared CI and production integration. AI-07 owns OS sandbox provider; no worker is authorized by this source-only change.

`CORE_EXECUTOR_DISPATCH_ENABLED=false` remains mandatory. No test fixture, signed request, JSON receipt or mocked HIGH/ACL status is a physical grant or host isolation proof.

## Original request data provenance
`CasRequest` is copied from exactly five own enumerable data descriptors (deviceId, epoch, requestId, fingerprint, capability) before provenance, identity or SQL awaits. Inherited fields, symbol keys, unknown extra keys, accessor descriptors and hidden non-enumerable fields fail closed. Authenticated scope and external receipt apply the same own-enumerable-data rule before their first downstream await. This is structural binding only, not signed identity proof.

## HTTPS ambiguous HTTP outcome boundary
The external CAS HTTP adapter must preserve uncertainty after dispatch. HTTP 408, 425, 429 and any 5xx may mean that a one-use reserve, revoke or re-pair committed before the response was generated. These outcomes map to the operation-specific UNKNOWN/transport-unknown denial code, never to a definitive refusal. The client does not retry internally. Explicit authority 403/409 responses remain refusals only under the independent authority's no-side-effect rejection contract. Neither code is a permit. Transport UNKNOWN requires independent reconciliation before any new mutation.

## Constructor authority invariance
The HTTPS grant transport and PostgreSQL-bound CAS each shallow-copy and freeze their trusted dependency configuration on construction. The root authority ID, credential resolver, external CAS provider and pool cannot be switched by later mutation of the caller's original settings object across async identity/SQL/HTTP awaits. The nested provider implementation and actual durable external grant custody still require separate independent verification.
