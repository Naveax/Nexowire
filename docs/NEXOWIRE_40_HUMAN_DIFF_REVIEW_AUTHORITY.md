# #40 independent human Git-diff review authority, source-only

## Verified upstream interfaces (2026-10-23)

- #04 PR #795 HEAD `70e9735007b648db83c2a6fa891ad624a8ef224f` declares `reviewAccessDiffApproval`, `ReviewedDiffRequest` and `APPROVED_SOURCE_ONLY_NO_MUTATION`. Its Ed25519 receipt binds owner/device/session, owner epoch, task, logical mutation, semantic effect SHA-256, worktree identity, preimage, base and diff SHA-256. It does **not** grant `canApply`, `canRollback`, `canLaunchElevated` or native HIGH.
- #32 PR #813 HEAD `734376b727d03fca2ddb438e8a0974c10ee0826b` exposes `ReviewedGitPatch.preview` returning `ReviewedPreview`: base/source SHA, task/worktree ID/root, approval epoch, before/after SHA-256, opaque `beforeVersion`, Git-compatible diff, 64-hex fingerprint. `ReviewedPatchPorts.verifyApproval` is a boolean port **not** authenticated by #795 by default. `apply`/`undo` rely on a real externally atomic scoped CAS port and durable monotonic journal. Its CI had run `39861891056` **IN_PROGRESS** at inspection; do not inherit its CI as proof.
- Both upstream PRs are unmerged and their source files are absent from `main` (HEAD `754cc4364822be5fda528f54042fb22a84f19924`). #40 therefore uses a narrow, independent **structural port** to avoid rewriting or importing owners' unmerged code.

## Binding and interaction contract

1. The server reads fresh #32 `preview` and #04 authenticated task/owner binding. Never accept the browser's diff, git root, source SHA, epoch, preference flags or a bare `approved=true` as the authority. A preview is **READ ONLY**; no approval, apply or native grant occurs.
2. Build `humanConsentChallenge40` from that trusted snapshot. Only a locally protected, **explicit human-action** Ed25519 signer may sign it. A coding agent/browser preference cannot mint a valid consent. Ticket expires in **30 seconds or less**, is domain separated and binds `APPLY` or `UNDO` as distinct actions, approval ID + nonce, immutable request/task/logical effect, owner/device/session/owner epoch and grant generation, #32 Git base/source SHA and approvalEpoch, exact worktree ID and identity hash, exact file/beforeVersion/before/after SHA-256, #32 preview fingerprint and SHA-256 of `preview.diff`. Changed patch or content generation requires a newly signed ticket.
3. `reviewHumanDiffConsent40` verifies the local signature and exact first trusted preview, then calls a **server-only** adapter invoking real #795 `reviewAccessDiffApproval` with a separately signed #04 local review receipt, `readAuthenticatedTaskBinding`, `readCurrentEpoch`, `isApprovalConsumed`, and, for rollback, independently verified previous native effect. Its `AccessSourceVerdict40` must explicitly report `canApply=false`, `canRollback=false`, `canLaunchElevated=false`, `effectiveElevatedPrivilege=false`. An input or mock claiming `canApply=true` is rejected.
4. The module re-reads the trusted snapshot *after* the #04 asynchronous verification. Any scope loss, owner revoke, epoch change, SHA/source/fingerprint/version change, expiry, `MUTATION_STATE_UNKNOWN` or cloned task denies. The final output is strictly `SOURCE_REVIEWED_NO_DISPATCH`, **never** a `ReviewedPatchPorts.verifyApproval=true` ticket or native grant.
5. Production still needs an independent protected signer enrollment, durable one-use consent ledger, genuinely linearizable effect admission/revocation and atomic filesystem CAS with symlink/hardlink/path safety, plus installed protected Broker for any HIGH effect. A second read is **not** an effect fence, and neither a source-level successful review nor a synthetic `verifyApproval` fixture can satisfy the external admission requirement. Without those providers: **BLOCKED / NO-GO**.

## Adversarial tests

Dedicated tests use ephemeral Node Ed25519 keys and a fake #04 boundary returning a source-only verdict; they do **not** claim #795's actual signature verifier has been invoked or that #32 has been deployed. Tested categories: stale consent, cloned task, forged signing key, tampered signed fields, swapped file/diff/generation/base/source/fingerprint, owner and grant epoch changes, revocation before and during async review, missing verifier, unsafe `canApply:true` witness, separate apply vs undo, and UNKNOWN cloned logical mutation. Run after integration with `node --test --import tsx test/human-diff-review-authority.test.ts` plus repository `npm run typecheck`/CI.

## Strict ownership

New standalone `src/coding/human-diff-review-authority.ts` and `test/human-diff-review-authority.test.ts` only; documentation here. No edits to #04 Access, `web/app.js`, #32 patch source, #31 Git executor, native Broker, Agent, UAC/ACL, VM, D1 or billing; no main merge. Do **not** substitute these tests for independent Git workspace sandbox and end-to-end native acceptance.


## NEXT2 exact source/CI and replay truth (2026-10-23)

| DRAFT PR | Exact reviewed HEAD | Exact hosted run | Result |
| --- | --- | --- | --- |
| #833 (prior #40 baseline) | `906fe0b97f4101f1f6eb774a6d0987e6232a1e37` | `39863705836` | **7/7 SUCCESS** before these NEXT2 test/docs commits |
| #813 (#32 reviewed patch) | `4570568c8bc28a061aa29578449eb7e5251480f4` | `39862100139` | **6/7 SUCCESS**, `browser-live` FAILURE; not production approval |
| #828 (#48 source-only UI) | `c092b925b02c7e6a5f4f397896d62473653f2667` | `39863006280` | **7/7 SUCCESS**; browser intent, not cryptographic approval |

**Actual #32 API:** `ReviewedPatchPorts.verifyApproval({identity,file,fingerprint,phase,ticket})` receives no typed `approvalId` or `reviewNonce` and has no installed verifier. #40 matches these fields in the separately signed #04 Access receipt, but a **server adapter** must decode the opaque ticket and invoke the actual #40 + #04 validators. Never treat a #48 `makeReviewIntent` callback, a browser-supplied consent flag, or a bare #32 `verifyApproval:true` stub as that adapter.

**Actual #40 replay gap:** The domain-separated Ed25519 statement binds each APPLY or UNDO phase, the exact #32 preview fingerprint, file generation, Git base/source OID, task/worktree, owner/device/session and live epochs; changing these between the two readbacks denies. An APPLY ticket cannot become an UNDO ticket. However, **replaying the same valid ticket for the same phase within its 30-second lifetime can repeat the successful SOURCE review** as long as the provider reports unchanged state. Neither #40 nor #04's read-only `isApprovalConsumed` provides an atomic one-use consume. Two fresh NEXT2 tests demonstrate this distinction and ensure both repeated results have **zero** native/effect permissions and that a #48 UI-only intent is denied. This is a real unclosed replay *authorization* gap, not evidence of a filesystem mutation.

**Required interface handoff (#01/#04/#32):** locally protected explicit-human signer with verifiable enrollment; externally durable **atomic** claim/consume of `(approvalId,nonce,phase,owner/device/task,worktree,diffFingerprint,ownerEpoch)` across clones/restarts/hubs; real #04 signature and task witness verification; external revoke-before-effect admission; #32 trusted scoped OS-atomic CAS writer and journal. A memory Set, client localStorage, pre-check of consumed status or two readbacks cannot satisfy this requirement. If any provider is absent, retain `SOURCE_REVIEWED_NO_DISPATCH`, `canApply=false`, `canUndo=false`, `canLaunchElevated=false` and **P0 physical NO-GO**. No owner #32 source, #04 Access source, #48 UI, Broker/Agent, UAC/ACL, D1, real filesystem or VM changed.

**CI provenance:** Historical 7/7 applies ONLY to old #833 SHA. New NEXT2 branch HEAD and new GitHub Actions checks must be reported separately; never inherit the old result or rerun queued/running same-SHA jobs.
