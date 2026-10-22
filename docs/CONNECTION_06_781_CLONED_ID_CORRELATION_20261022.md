# NEXOWIRE #06: cross-runbook / reconnect correlation audit for #781

Date: 2026-10-22. **Connection-owned negative QA only. No production source fix or permission grant.**

## Exact provenance

- #770 Connection parent HEAD `131d96cdab40a68f0b12c6991d330e9d62573bf0`; hosted run `39804271245` **COMPLETED SUCCESS (7/7)**. This branch must be based directly on that exact commit.
- #781 independent hostile QA HEAD `89a865363829c8c30a74de1516e53a697549c05b`; hosted `39816363122` **COMPLETED SUCCESS (7/7)**. Its **PASS is evidence of unsafe behavior**, not evidence of fixed UNKNOWN replay.
- #777 Artifact resume guard HEAD `c41e441a87f5d22101b8d256b1b64047a551cc0e`, run `39807272228` **overall FAILURE**, six success and only Windows Job browser-live fast-exit stdout regression failed. It protects **same resumeTransferId**, not cloned runbook semantic identity.

## Independent source-boundary result

The existing `reconcileConnectionBoundAgentOperation` requires the same exact Hub `operationId`, authenticated device, requested capability, fingerprinted payload, and independently fingerprinted Agent journal record. It never returns external OS effect proof or a replay permit. Existing tests already reject wrong UUID, device, access mode and payload.

But these are **per-operation checks**, not proof two operations refer to DIFFERENT logical effects. The current Hub idempotency record, Agent operation journal, and #770 Connection bridge lack persistent `logicalMutationId` / immutable task/effect fingerprint and protected ownerEpoch binding **across a new runbookId, nested graphId or fresh request UUID**. A newly keyed Hub record with the same capability/payload can independently match a new Agent journal row even if the old request is UNKNOWN. Reconnect/session ownerEpoch rollover is not an argument to this current synchronous bridge. The clone cannot inherit or neutralize the UNKNOWN of the first effect.

The new test `test/connection-781-clone-correlation.audit.test.ts` uses **only disposable metadata**:
1. Two Hub idempotency keys representing original vs cloned runbook generate **different** operation UUIDs for the same logical payload/capability/device.
2. The first Agent row remains `unknown`; the cloned Agent row independently claims `succeeded`. Synthetic ownerEpoch rotates 7→8 and 8→9 outside this API, because there is no authenticated current owner-epoch input.
3. Connection returns `unknown` for original and per-request `agent_confirmed` for clone. **Both** have `externalSideEffectProven:false` and `automaticallyRetryable:false`. The cloned terminal journal still does NOT prove true completion or authorize replay.
4. Cross-substituting the original Agent operation UUID for the clone correctly returns `journal_mismatch`. Thus exact UUID correlation works; **cross-ID logical identity is unrepresented**.

This is a deliberately *unsafe negative QA witness* for the wider runbook runtime, **not** a new requirement to trust clone status. It must not be used to label #01's runbook implementation safe.

## #01 runtime/journal owner action (not #06)

- Persist a **stable immutable logicalMutationId** before first potentially effective dispatch, scoped to protected owner/device, requested capability + canonical immutable payload/effect fingerprint and operation/step lineage. New runbookId, nested graphId, chat/sessionId or requestId must NOT reset this identity.
- On lost ACK or `MUTATION_STATE_UNKNOWN`, preserve `UNKNOWN/RECONCILE_REQUIRED` plus original effect identity and ownerEpoch; never downgrade to `FAILED` or classify as new work solely due changed runbookId.
- Before any cloned resume, independently revalidate protected **current ownerEpoch/grant generation**, destination session epoch and physically authenticated immutable effect readback. A local Agent/Hub `succeeded` row, HMAC-looking token, or changed request UUID is NOT an authority witness.
- The actual dispatch/COMPLETE transition needs rollback-independent external one-time CAS against revoked owner and logical effect high-water; if proof unavailable: deny and no replay.
- Provide a real read-only, nonce-bound owner-epoch witness to Connection. Existing `#770` transfer journal bridge is read-only and must not call side-effecting `#712 beginIfCurrent`.

No change to `src/agent/runbooks.ts`, `src/agent/runbook-store.ts`, `src/agent/operation-journal.ts`, `src/mcp/cross-device-transfer-jobs.ts`, protected Broker or live Agent/VM.

## Acceptance

This Connection negative QA should remain **green on current unsafe source**, documenting the missing cross-runbook correlation. It is NOT a protective fix. #01 owns a future RED→GREEN runtime test and actual durable implementation; at that point this negative QA should be converted to expect blocked duplicate dispatch only when a real authoritative cross-ID identity is implemented and trusted. #587 rollback-independent CAS and physical Native acceptance remain **BLOCKED**.
