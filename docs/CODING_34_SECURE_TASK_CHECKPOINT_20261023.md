# #34 secure task checkpoint and context compaction (#780)

Date: 2026-10-23. Isolated DRAFT only. Main baseline `754cc4364822be5fda528f54042fb22a84f19924`. Coordination #539.

## Source inventory before implementation

- #783 latest observed HEAD `3dc5f12fdbf7f3ab101c1c6e73e7c508d644f0c9` is #01 advisory read-only Agent loop identity. It binds original logicalMutationId, requestId, worktreeId, sourceSha and grant epochs; **never authorizes execute/replay**. Cloned UNKNOWN runbook #781 is a real source negative. #794 source/worktree drift remains an independent fail-closed classification test.
- #807 latest observed HEAD `1e84d87c98c91b2d6e97a47de610ffe353d199df` is #08 Artifact publication checkpoint admission, not a general task checkpoint store. Its `saveIfCurrent` requires an independently protected off-host atomic provider **which is not deployed**. Exact workflow run `39841880930` was FAILURE at initial inventory, not assumed green.
- Main `src/coding` did not exist. All #34 source is in `src/coding/secure-task-checkpoint/index.ts` and isolated `test/secure-task-checkpoint.test.ts`; no Agent OperationJournal, RunbookStore, Artifact Bridge, Agent, Broker or native execution changes.

## Metadata-only contract

`SecureTaskCheckpointSchema` is a strict allowlist. Unrecognized command, argv, shell text, tool output, environment, token, password, raw diffs, private file content, free-text summary and nested approval/CI extras are rejected. ID/error-code strings are shape-constrained; high-confidence credential prefixes in IDs are rejected. This is defense against *accidental* raw secret inclusion, not a general-purpose secret scanner: a secret deliberately encoded as an otherwise valid digest/UUID cannot be recognized from its format alone. Required: owner/device/task, exact sourceSha and worktreeId, ownerEpoch/grantGeneration and signed grant *digest* (not a grant token); immutable logicalMutationId and original requestId/fingerprint; bounded steps/tools/elapsed budgets; cancellation; explicit approval decision/diff fingerprint; exact SHA/workflow/run/conclusion CI witnesses; enum-only step events. Absent, forged, contradictory, oversized, or extraneous metadata fails validation.

`SecureTaskCheckpointStore` encrypts JSON using AES-256-GCM with per-write random 96-bit nonce and canonical domain/version/file-path **plus full scope AAD** (owner, device, task, worktreeId, sourceSha, ownerEpoch, grantGeneration and signedGrantScopeDigest). Expected scope is GCM-authenticated *before plaintext parsing*, then independently validated against the decrypted strict schema. The AAD change intentionally refuses the earlier draft's path-only ciphertext: these source-only draft checkpoints have no production migration promise. Only hashed owner/device/task is exposed in local file names. The caller **must** supply an existing private directory and a 32-byte key from a trusted OS secret store; key custody, ACL enforcement and independent grant verification are outside this module. Keys are never serialized. Restore rejects authentication/tag errors, ciphertext corruption, wrong key, wrong identity, changed epoch/SHA/worktree/grant scope, cancellation/revocation, and exhausted counters. Returned verdicts are only `STOP`, `RECONCILE_REQUIRED`, or `INSPECT_ONLY`; `mayDispatch:false`, `mayReplay:false`, `completedVerified:false` always.

For mutation UNKNOWN, `pendingUnknown` and original errorCode remain sticky and the original logicalMutationId/requestId are never rewritten by `update`. Restored UNKNOWN requires external read-only reconciliation; no cloned runbook or new requestId bypass. This module does not call `retryUnknown`.

The deterministic `compactTaskContext` discards enum-only event detail into a chained SHA-256 digest and count, retaining original identity, UNKNOWN, budgets, cancellations, **all** approvals and **all** exact CI witnesses. `update` checks prefix preservation or a precisely computed compaction against the authenticated prior snapshot, then writes a local encrypted temp file, fsync and rename. The temporary `*.tmp` file is never a recovery authority. Crashed/truncated primary yields `STOP`, never a fresh empty checkpoint. The counters and array limits are bounded rather than silently truncating evidence.

## Security boundaries and blockers

1. A local authenticated encrypted file, revision digest, fsync, rename, check-then-write or in-process mutex **does not provide independently protected CAS**, global replay exclusion, or atomic ordering against revoke-start. A concurrent writer or filesystem rollback is not securely prevented here.
2. The `grantActive` argument is an advisory denial input from a trusted caller; passing true does **not** verify a signed grant or grant execution permission. No agent executor consumes this module, intentionally.
3. A witness's CI conclusion is only *metadata*, not an independently validated GitHub signature or physical release acceptance; callers must verify exact run and SHA using GitHub before treating CI as external evidence. A local SUCCESS field never implies native effect.
4. External #587 non-restorable mutation CAS, protected grant/current-worktree authority, real #807 atomic checkpoint admission and external signed outcome readback are still P0 **BLOCKED**. Local restore must not dispatch Native/Broker/Agent actions or resume mutations without those independent gates.

## Negative fixture coverage

Disposable deterministic tests cover encrypted restart, malformed and **well-formed tag-corrupted** ciphertext, legacy path-only AAD against new worktree/source/grant scope, wrong key, crash-truncated primary, inability to overwrite corrupt primary, stale/revoked epoch/worktree/SHA, lost-ACK UNKNOWN, rejection of nested approval/CI output fields and credential-shaped IDs, expired budget, cancellation stickiness, approval/CI witness erasure, stale revision, changed mutation identity, and multiple compaction cycles retaining UNKNOWN and exact evidence.

**No main merge, live Agent, Broker, UAC, D1, VM, user files or deployment.** This PR is a source-only building block, not production authorization.
