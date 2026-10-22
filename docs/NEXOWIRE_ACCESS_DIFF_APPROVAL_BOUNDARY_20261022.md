# #04 Access P1/P0 seam — signed diff review is not CORE/elevated or native effect

**2026-10-22. Isolated source-only child of #775. No live operations.**

## Cross-PR/issue evidence
- #775 HEAD `2184612804ed4db16ed6e0e1a3acbd1cc2400955`, exact hosted CI [#39806640003](https://github.com/Naveax/Nexowire/actions/runs/39806640003) **SUCCESS**. Its `Access` signed FINAL native CAS grant still returns `canLaunch:false` even with valid synthetic inputs.
- #767 HEAD `6967cc92ae85e5d1034591940d273615c4056e00`: installed Broker signed FileID/PID/FILETIME and CAS final grant are source contracts, not physical Windows HIGH installed token or atomic effect.
- #764 HEAD `12137946976c6cbcf70740e2a3b3737aed427d0c`, hosted CI #39803317749 **SUCCESS**: two-Hub `reserve→commitForDispatch` is TEST-ONLY. Revoke wins => no effect. Commit wins, readback lost => `MUTATION_STATE_UNKNOWN`, never automatically retry.
- **#780 is a GitHub ISSUE/epic**, not an open PR (get-pr returned 404, issue fetch succeeded). It defines P1 reviewed Git worktree diff `preview/approve/reject/apply/rollback`, base SHA, owner/device grant, path policy, post-change hash readback and replay/cancellation. It explicitly says P1 diff approval must not loosen #271/#551/#587/#617 and CORE/HIGH is a **separately signed** authority outside the sandbox. There is **no #780 code diff to review**.

## Narrow Access owner interface

New `src/product/access-diff-approval-boundary.ts` is pure server-side **SOURCE status only**, not a Git or file mutation engine. Its strict Ed25519 receipt binds:
- `LOCAL_USER_REVIEW_ONLY` scope (never an OS token, Windows UAC, or permanent CORE enrollment),
- exact `approvalId/requestId/reviewNonce`, owner/device and deviceEpoch/sessionEpoch/ownerEpoch/grantGeneration,
- action `apply` or separately approved `rollback`, requested SAFE/FULL/ROOT/CORE, base and diff SHA,
- exact previous native effect ID for rollback, and bounded issued/expiry times.

The caller-supplied `clientCoreEffective`, `clientApprovalGranted` and raw Agent telemetry are untrusted and never used as authority. The trusted server context must match current owner login, device and *current actual Git base/diff SHA*, an independent live external CAS owner/device/session epoch with **`revoking:false`**, and a separately durable already-consumed approval ledger. CORE/ROOT additionally demand fresh `AccessEffectiveAuthority.project` using current independent installed protected Broker and D1/CAS proofs; a user-selected CORE preference is NOT effective privilege, and SAFE/OFF cannot be overridden by a synthetic signed receipt.

`preview` is read-only, never creates approval or elevation. `apply` requires its **own** valid locally signed review grant. `rollback` must carry a **distinct rollback-scoped** review grant plus independently read and verified **previous** native `COMPLETED_VERIFIED` effect; `MUTATION_STATE_UNKNOWN` or forged postcondition denies. A reviewed diff approval **does not prove native effect occurred**. Revoke-start or re-pair between initial review and the second external high-water read denies; approval expiring during asynchronous proof read also denies.

**All successes are explicitly SOURCE ONLY**: `APPROVED_SOURCE_ONLY_NO_MUTATION` with `effectiveElevatedPrivilege:false`, `nativeEffectVerified:false`, `canApply:false`, `canRollback:false`, `canLaunchElevated:false`. No per-command *Windows UAC* is required after a legitimately once-approved signed CORE enrollment; this separate **per-diff review** is not repeated Windows UAC and cannot itself grant HIGH. No native effect callback, patch apply, rollback, local OS privilege or remote external CAS mutation was attempted.

## Negative acceptance and remaining NO-GO
`test/access-diff-approval-boundary.test.ts` verifies:
- preview and cached CORE/approved UI always nonauthoritative;
- forged signer, unapproved or reused receipt, strict signed JSON wrong types/additional `elevated` field and approval expiry;
- stale Git base/diff, action/mode, owner, device, request, session or device/owner epoch/generation;
- CORE preference OFF/SAFE/direct Broker even if synthetic Access provider says EFFECTIVE, FULL remains standard-user;
- external revoke-start, changed owner/re-pair/reconnect epoch and lost CAS readback; delayed review invalidated by expiration;
- independent prior-effect native readback for rollback, UNKNOWN never auto-undo or replay.

#780's actual worktree patch application/path sandbox/Git rollback remains the separate P1 implementation owner's job. No assumption that an in-process signed synthetic fixture is a physically provisioned local user-review signer or installed Windows HIGH/native effect. **#271 live inherited Authenticated Users Modify, #551 signed installed Broker/rollback, #587 external atomic CAS and native-effect authority, #617 physical HIGH attestation remain PRODUCTION NO-GO.**
