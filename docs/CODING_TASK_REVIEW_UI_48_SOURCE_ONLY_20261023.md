# #48 Coding task diff review UI contract (2026-10-23)

Scope: `web/coding-task-review.mjs`, optional standalone `web/coding-task-review.html`, declaration and independent unit/UI regressions. No `web/app.js`, #04 Access code, #23 QA, Agent, Broker, D1 or workflow modification. UI is a source-only interface, not wired to production.

## Integration contract for #32 / #40

- #32 must supply an independently scoped **complete** unified diff and bounded file summary with immutable `ownerId`, `deviceId`, `taskId`, `logicalMutationId`, original `requestId`, `worktreeIdentitySha256`, `preimageSha256`, exact `baseSha256`, `sourceSha256`, `diffSha256`, `semanticEffectSha256`, device/session epochs, owner epoch and grant generation. Do not silently substitute the Git repository HEAD for file preimages.
- #40 must perform server-side authenticated current readback and signed short-lived human review approval. The UI's `onIntent` callback only requests a review, **never an effect**. It emits no native dispatch, rollback, UAC, CORE or HIGH grant. Re-check original scope, approved action, diff fingerprint, expiry, one-time nonce, signer, revocation and off-host CAS at native admission. Local equality cannot prove external CAS.
- `current.effectState` must be one of `NOT_DISPATCHED_VERIFIED`, `MUTATION_STATE_UNKNOWN`, `COMPLETED_VERIFIED`, or another unverified value. Only an exact `NOT_DISPATCHED_VERIFIED` preview with `revoking:false`, `revoked:false`, `conflict:false` allows **intent request**. UNKNOWN must reconcile, not retry. Completed effect is post-effect and cannot be undone merely by a UI preference.
- Deadline must be supplied, still future, at most 5 minutes away *on the client*. #40 must use its own trusted clock and native CAS and must not accept the local clock as authority. Changed revision/ownerEpoch/generation rejects intent, including already rendered views (click revalidates).
- `input.proof.physicalVerified`, `nativeHigh`, `externalCas` and other client-side assertions are not physical evidence. The UI rejects forged proof claims instead of showing a green physical status. Both claims and any source CI status remain **unverified** here. Actual verification must come from separate trusted native signer/physical installed Broker and external CAS witnesses, not UI data.
- Mark all source-only candidate states as `canDispatch:false`, `canApply:false`, `canRollback:false`. No application code calls these as execution permits. A full reviewed patch is limited to 20,000 UTF-16 code units/80 file rows; oversized previews block intent rather than truncating evidence and approving unseen changes.

## UI behavior / negative coverage

`projectTaskReview` provides deterministic fail-closed projection; `mountTaskReview` uses `textContent` only. The standalone page has a no-connect CSP and empty blocked state unless a future authenticated host supplies a projection. Tests deny forged proofs, stale source/diff, revoked/expired ownerEpoch, conflict, expired intent, UNKNOWN replay, completed effects, hostile text markup and click-time TOCTOU. These are **source/UI tests**, not a real browser, installed Windows HIGH Broker, OS sandbox or two-Hub physical CAS acceptance.

**Physical acceptance: NO-GO.** No #32 reviewed apply adapter or #40 production human-authority API was verified at creation time. This PR intentionally has no dispatch integration and must not be represented as production-ready.
