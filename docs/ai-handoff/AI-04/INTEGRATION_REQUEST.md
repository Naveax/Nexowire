# AI-04 -> Coordinator / AI-05 / AI-07 / AI-08

## Required security handoff (no cross-agent source edits)
1. AI-05: wrap every separate irreversible Windows effect with an independently validated Broker admission. Use a stable original operation UUID per effect, with exact immutable input digest and owner/device/session/generation scope. Do not treat one outer `executor` admission as multiple effect CAS acknowledgements. Integration in `src/agent/executors.ts` belongs to AI-05, not AI-04.
2. Independent Broker authority owner/coordinator: implement real pinned `verifyReceipt(receipt,signedPayloadUtf8)` that checks **the exact argument bytes** and a durable one-use reservation/commit/UNKNOWN/revoke backend. Test verifiers returning true are not installation evidence.
3. AI-07/coordinator: require real OS token/handle/publisher readback for installed Broker and Job worker. Hosted Windows 2025 evidence in CI run `41194719016` explicitly blocks equal-HIGH acceptance because SeDebugPrivilege was enabled and the linked Medium token could not be issued. The pre-seal duplicated Job-handle window remains independently OPEN. Treat UNKNOWN as deny, not success.
4. AI-08: independently assess #987 negative tests, Windows Job blocked cases, MSVC C4133 behavior, and compare exact HEAD CI evidence. A successful fixture run is **not** physical release acceptance.
5. Coordinator only: if Windows CI needs new isolated test setup, own the workflow change. Do not weaken source negatives, suppress C4133, alter physical gates, or treat a hosted token as the owner's PC.
 
## Proposed minimum contract
- Admission input: `{ operationId: UUID, capability, inputSha256, binding: { authorityId, ownerId, deviceId, sessionId, ownerEpoch, deviceEpoch, sessionEpoch, generation, highTokenProofId, protectedBrokerProofId, expiresAtMs } }`.
- `readVerifiedBinding()` and `readVerifiedBindingNow()` return plain own-data witness snapshots or null (fail closed). Their source-side snapshots provide NO independent OS proof.
- `begin(request, nonce)` and `commit(request, ticket, nonce)` must return independently signed RESERVED/COMMITTED exact-byte receipts. Lost ACK => sticky UNKNOWN. No mutation callback on UNKNOWN, revoke, mismatched binding, expired budget or token uncertainty.
- Release gate remains **NO_GO** until OS and independent authority contracts are installed and separately verified on authorized hardware.

## Newly identified handle-inheritance boundary
- AI-04 owns a narrow change to `native/windows-job-owner.c` that replaces broad `CreateProcessW(..., TRUE, ...)` inheritance with an explicit `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` containing only deliberately duplicated standard IO handles.
- AI-07 still owns the complete worker token/handle/environment policy. AI-08 should verify the Windows native build + Job launch with this change at the new exact commit. Existing equal-HIGH, pre-seal and UAC-linked kernel proof blockers are independent.
