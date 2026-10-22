# #04 Access — reviewed diff grants across worktree scopes and cloned UNKNOWN

**2026-10-22 | Independent SOURCE-ONLY child of #787.**
This is not a Git workspace-root fix, sandbox, durable runbook engine,
protected Windows Broker or atomic remote CAS deployment.

## Exact cross-owner findings

- Parent #787 HEAD `3fe56ef39ab604a472974946dd31b4e016287f46`, exact
  hosted [#39817200109](https://github.com/Naveax/Nexowire/actions/runs/39817200109)
  **SUCCESS**. Its prior Ed25519 LOCAL_USER_REVIEW_ONLY receipt bound
  requestId, owner/device epochs and Git base/diff SHA but did NOT bind
  task identity, canonical linked worktree, file preimage or durable
  logical mutation identity. Same base/diff can exist in multiple worktrees.
- #775 HEAD `2184612804ed4db16ed6e0e1a3acbd1cc2400955`, exact hosted
  [#39806640003](https://github.com/Naveax/Nexowire/actions/runs/39806640003)
  **SUCCESS**, but final source grant always `canLaunch:false`.
- #786 HEAD `8d5390dc8ed94e13ac380c6e37aa6f4de2888d4b`, hosted
  [#39817020745](https://github.com/Naveax/Nexowire/actions/runs/39817020745)
  **FAILURE**. Real `executeCapability('workspace.snapshot')` checks
  requested cwd with `PathPolicy` but then trusts Git-discovered
  `rev-parse --show-toplevel` outside the approved nested task root
  and leaks an out-of-scope package marker. The new unchanged QA asserts
  a DENIED result and currently fails. Git worktree `.git`/common-dir
  can likewise be external. **This Access PR does not touch the owner
  executor or turn this RED test green.**
- #781 HEAD `89a865363829c8c30a74de1516e53a697549c05b`, hosted
  [#39816363122](https://github.com/Naveax/Nexowire/actions/runs/39816363122)
  **SUCCESS** but the adversarial test deliberately reproduces UNSAFE
  behavior: `executeDurableRunbook` translates a lost OS ACK
  `MUTATION_STATE_UNKNOWN` to failed and a clone under a new
  `runbook_id` calls the same synthetic native effect a second time.
  No persistent semantic-effect identity or independent CAS outcome
  readback exists in that actual runbook API. Passing negative test
  does **not** prove runbook safety.
- #780 is an open **P1 ISSUE**, not PR; its feature acceptance requires
  Git worktree approval scope, base/preimage SHA, owner epoch,
  stable immutable request/effect identity and no blind replay on UNKNOWN.
  The real task/sandbox/runbook components remain separate owners.

## Narrow #04 Access contract change

Only `src/product/access-diff-approval-boundary.ts` and its existing
unit tests are changed. An approved receipt is STILL
`LOCAL_USER_REVIEW_ONLY`, not OS elevation or native effect.

A signed review receipt now binds **required** `taskId`,
`logicalMutationId`, `semanticEffectSha256`,
`worktreeIdentitySha256`, `preimageSha256`, in addition to exact
action, owner/device/epoch/generation, request ID and base/diff SHA.
These fields are included in the canonical Ed25519 signing bytes and
validated with strict UUID/hex SHA schemas. Older v1 receipts without
these required fields fail closed.

A new server-injected `readAuthenticatedTaskBinding(taskId,
semanticEffectSha256)` provider MUST read a **current, independently
authenticated** task scope (not a caller-provided approval/Agent flag).
It must verify the *resolved Git root* and `.git` gitdir/commondir
remain authorized within the actual task root and match immutable
worktree identity and original file preimage. The provider must derive
the **canonical semantic effect SHA from operation content and owner
scope**, not trust a renamed runbook ID or client-provided hash; its
durable result must be keyed by that semantic operation across clones,
restarts, power loss and owner re-pair. No suitable installed provider
is currently available, so an absent provider throws and denies.

Both before independent CAS epoch review AND after the second external
CAS revoke/epoch check, Access verifies that full task binding and
`mutationState==='NOT_DISPATCHED_VERIFIED'` are current. Unknown,
UNVERIFIED or COMPLETED results never create a new apply grant.
A changed resolved worktree, common-dir, preimage, task identity or
owner/device/session epoch denies even when Git base/diff SHA and the
old signed approval are otherwise valid. No blind replay under a
different requestId or cloned runbook/task ID.

**Source-only invariant:** even all synthetic positive proofs yield
`APPROVED_SOURCE_ONLY_NO_MUTATION`, `canApply:false`,
`canRollback:false`, `canLaunchElevated:false`,
`effectiveElevatedPrivilege:false`, `nativeEffectVerified:false`.
The callback is a contract, not a deployed physical provider. Actual
#786 `workspace.snapshot` still exposes the out-of-root marker until
its owner reauthorizes Git-discovered roots and metadata via
real OS-native/PathPolicy. #781 runbook loop still clones UNKNOWN until
its owner implements a durable cross-runbook semantic effect quarantine
and authenticated current epoch readback. No #01/#03/#05/#18 source
or UAC/ACL/VM/service was changed.

Legitimately once-approved permanent CORE remains broad elevated
only after real installed signed Windows HIGH Broker and independently
atomic external native-effect dispatch are physically accepted.
There is **no additional Windows UAC prompt per authorized CORE
operation**; per-diff approval is a separate review step and never
silently raises privilege.

**P0 NO-GO:** #271 installed writable inherited ACL, #551 signed
native importer/updater chain, #587 true external rollback-independent
atomic CAS/effect linearization, #617 physical installed HIGH token,
#786 out-of-scope Git API, and #781 cloned UNKNOWN effect.
