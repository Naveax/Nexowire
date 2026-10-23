# #48 Coding task diff review UI contract (2026-10-23)

Scope: `web/coding-task-review.mjs`, optional standalone `web/coding-task-review.html`, declaration and independent unit/UI regressions. No `web/app.js`, #04 Access code, #23 QA, Agent, Broker, D1 or workflow modification. UI is a source-only interface, not wired to production.

## Integration contract for #32 / #40

- #32 must supply an independently scoped **complete** unified diff and bounded file summary with immutable `ownerId`, `deviceId`, `taskId`, `logicalMutationId`, original `requestId`, `worktreeIdentitySha256`, `preimageSha256`, exact Git commit `gitBaseSha`, `gitSourceSha` (40/64 hex), `baseSha256`, `sourceSha256`, `diffSha256`, `semanticEffectSha256`, device/session epochs, owner epoch and grant generation. Do not silently substitute the Git repository HEAD for file preimages.
- #40 must perform server-side authenticated current readback and signed short-lived human review approval. The UI's `onIntent` callback only requests a review, **never an effect**. It emits no native dispatch, rollback, UAC, CORE or HIGH grant. Re-check original scope, approved action, diff fingerprint, expiry, one-time nonce, signer, revocation and off-host CAS at native admission. Local equality cannot prove external CAS.
- `current.effectState` must be one of `NOT_DISPATCHED_VERIFIED`, `MUTATION_STATE_UNKNOWN`, `COMPLETED_VERIFIED`, or another unverified value. Only an exact `NOT_DISPATCHED_VERIFIED` preview with `revoking:false`, `revoked:false`, `conflict:false` allows **intent request**. UNKNOWN must reconcile, not retry. Completed effect is post-effect and cannot be undone merely by a UI preference.
- Deadline must be supplied, still future, at most 5 minutes away *on the client*. #40 must use its own trusted clock and native CAS and must not accept the local clock as authority. Changed revision/ownerEpoch/generation rejects intent, including already rendered views (click revalidates).
- `input.proof.physicalVerified`, `nativeHigh`, `externalCas` and other client-side assertions are not physical evidence. The UI rejects forged proof claims instead of showing a green physical status. Both claims and any source CI status remain **unverified** here. Actual verification must come from separate trusted native signer/physical installed Broker and external CAS witnesses, not UI data.
- Mark all source-only candidate states as `canDispatch:false`, `canApply:false`, `canRollback:false`. No application code calls these as execution permits. A full reviewed patch is limited to 20,000 UTF-16 code units/80 file rows; oversized previews block intent rather than truncating evidence and approving unseen changes.

## UI behavior / negative coverage

`projectTaskReview` provides deterministic fail-closed projection; `mountTaskReview` uses `textContent` only. The standalone page has a no-connect CSP and empty blocked state unless a future authenticated host supplies a projection. Tests deny forged proofs, stale source/diff, revoked/expired ownerEpoch, conflict, expired intent, UNKNOWN replay, completed effects, hostile text markup and click-time TOCTOU. These are **source/UI tests**, not a real browser, installed Windows HIGH Broker, OS sandbox or two-Hub physical CAS acceptance.

**Physical acceptance: NO-GO.** No #32 reviewed apply adapter or #40 production human-authority API was verified at creation time. This PR intentionally has no dispatch integration and must not be represented as production-ready.

## #48 NEXT2 cross-review: exact immutable field coverage (#813 / #833)

#813 `ReviewedIdentity` supplies `ownerId`, `taskId`, raw
`worktreeId` and `worktreeRoot`, Git `baseSha/sourceSha`, and
`approvalEpoch`. Its `ReviewedPreview` supplies `file`,
`beforeSha256`, `beforeVersion`, `afterSha256`, `fingerprint` and
raw `diff`. **It does not supply** #48 `deviceId`, `requestId`,
`logicalMutationId`, `semanticEffectSha256`, authenticated
`worktreeIdentitySha256`, `deviceEpoch`, `sessionEpoch`,
`ownerEpoch`, `grantGeneration`, nor #04 `accessBaseSha256` and
`accessDiffSha256` as signed/attested independent inputs. The source
`beforeSha256` can map to `preimageSha256` only through a trusted
scope adapter. `baseSha/sourceSha` Git OIDs are not the #04 access
content SHA-256 fields.

#833 `AuthoritativeReview40` supplies the missing scope bindings and
`HumanConsentStatement40` binds `patchFingerprintSha256`,
`beforeVersion`, `file`, `afterSha256`, `worktreeId`,
`approvalEpoch` and `gitBaseSha/gitSourceSha`. The #48 UI now
supports an **optional untrusted display-only** `approvedReview`:
`{statement: HumanConsentStatement40, diff: originalReviewedDiff}`.
If present it requires `proposed.patch`, `current.patch`, and
`proposed.requestedMode/current.requestedMode`, matching all source
identity, mode, exact patch identifiers and original diff text.
Any omitted or changed field displays `STALE_READ_ONLY` and disables
intent, including a display mutated without a corresponding changed
`diffSha256` claim. It does **not** validate the receipt signature or
sha256 bytes and must not be interpreted as a trusted authorization.
The server **must** independently verify the SHA-256 over the diff
bytes, Ed25519 receipt and matching current provider before any effect.

A matching client display is labeled `DISPLAY_MATCH_UNVERIFIED`,
never HIGH; forged preference, approval, dispatch and physical flags
deny local review intent and cannot enable native privilege. No
`#32` apply/undo edits, #04 web/app.js, #23 QA or production wiring.


## #48 NEXT4 #32 native nested identity cross-review (2026-10-23)

Verified unmerged #32 #813 HEAD `4570568c8bc28a061aa29578449eb7e5251480f4`:
`ReviewedPreview.identity` has `ownerId/taskId/worktreeId/worktreeRoot/baseSha/sourceSha/approvalEpoch`,
and preview has `beforeSha256/beforeVersion/afterSha256/fingerprint`.
#40 #833 HEAD `7cc50cd5dfb8b3bafe350bcc500c7ba46c252ce1` signs the
worktree ID and base/source OIDs and approval epoch but not raw `worktreeRoot`;
trusted #32 attestation must independently re-check the authorized root.

A **real view-only gap** existed: if `proposed.patch.identity` and
`current.patch.identity` were supplied but nested source OID, cloned
approvalEpoch or worktreeRoot changed, the flattened `patch` row could
still appear identical. The display comparison now requires both native
identity objects if either is present, checks all seven fields, the
native preview preimage SHA, and exact approved Git/source/epoch scope.
Any mismatch, absent identity half or mutation after render makes the
approved snapshot `STALE_READ_ONLY`, with no review intent.

Legacy flattened UI projections without a native identity remain
unverified visual fixtures, **not authorized #32 previews**. An entirely
omitted or identically forged client-native identity cannot prove root
integrity; production integration must supply independently attested,
fresh canonical resolved worktree and Git metadata plus a server-side
hash/signature/CAS validation. Lexically unchanged root can still be
symlink-rebound. #40 has no deployed physical issuer, and #32 still lacks
the actual atomic filesystem CAS provider. No source CI or UI display
becomes HIGH, native apply, rollback or release proof. P0 NO-GO.
