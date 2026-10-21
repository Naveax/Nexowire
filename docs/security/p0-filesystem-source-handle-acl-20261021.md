# #05 Windows native file source and protected ACL acceptance (2026-10-21)

## Ownership / scope

Isolated child branch of #553 (fddbdfea8d3b034105e198e7fc0489e3c6ee466e), owned by #05. Independently review #26's native-handle adversarial evidence in DRAFT #647; do not edit its QA-owned files. No edits to #08 Artifact Bridge store or transfer owner. No active service, installer, Broker, physical USB, user files, ACL changes, UAC, or VM.

This source-only preflight does NOT add an elevated filesystem capability to the production Broker. Its protected OS witness provider is unimplemented in production. A synthetic positive test means the policy contract accepts the fixture, not that physical Windows/CORE is approved.

## Mandatory fail-closed gates

1. Source is selected from a protected installed-manifest witness, never solely from remote MCP JSON. Requested path must match independent pinned source; deny UNC/NT namespaces, alternate data streams, traversal and prefix siblings.
2. Source and destination parent require independent same-open-handle file ID + volume serial/GUID, disk and partition identity checked twice. Deny changed handles after rename/recreate, retargeted junction, reparse tags, hardlinks, ADS, mismatched canonical final paths or missing no-follow verification. Preflight snapshots alone do not make later pathname writes atomic.
3. Each separate protected component must pass OS-native read-only ACL/signer witnesses: ProgramData parent, updater tree and module import tree. Require trusted owner, protected DACL, no untrusted write/delete/ownership ACEs, no reparse links, complete ancestors and descendant inspection, pinned publisher and digest. Provider unavailable => DENY; mock flags are not real Authenticode/ACL attestation.
4. Destination grant must match owner/device, exact scope and within-root target, monotonic expiry and current delegation epoch, verified local approval, and opened parent volume GUID + disk ID + partition number. Removable writes additionally require USB approval. The existing production native Agent must KEEP denying USB/grant-only writes pending a safe atomic Windows writer.
5. Existing CORE preflight denies unverified high token, medium-integrity caller, owner mismatch, forged request source. A UI CORE badge is not token evidence.

## Executable tests

- npm run typecheck
- npm run build
- node --test --import tsx test/p05-native-source-handle-acl-negative.test.ts test/broker-filesystem-preflight-negative.test.ts test/windows-native-filesystem-handle.test.ts
- node --test --import tsx --test-name-pattern=">256 MiB offset" test/agent-large-file-stream.test.ts
- Agent filesystem / Windows scoped-grants regression, without enabling the physical 1GiB fixture.

Real Windows kernel32 read-only handle/junction/hardlink/ADS checks only create test objects in disposable TEMP. A 320MiB logical sparse file exercises >256MiB offset and SHA without allocating physical 1GiB.

## Production NO-GO

No OS-protected source-witness provider, signed high-token Broker, or atomic handle-relative filesystem mutation executor is wired. Physical Windows parent/updater/module ACL, signed installer and rollback, DPAPI owner key and revocation require separate #271/#551/#632/#633 acceptance. Independent #647 source tests do not attest running Agent v1.0.5. GitHub CI alone does not prove real USB hotplug or CORE elevation.

Do not merge or deploy. Preserve WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED and the strict shell/WSL denial.

## 2026-10-21 #05 child: effective ACL ACE masks + verified relative handle chain

Stacked on #673 (exact parent SHA 2c78cedc6ee9ce6ebc0f5de635de47a6bcdcc449). Independent #26 #657 exact HEAD 561af65b6cc1659f413bf11918b4ff356738c960 has separate GitHub CI SUCCESS; do not merge or modify its tests.

New source contract `src/agent/windows-native-relative-access.ts` authenticates a *trusted witness-provided* chain of read-only **OS-open directory handles** from a server-selected grant root through per-segment child handles. It checks native parent file ID, stable post-open identity, same physical volume GUID/serial/disk/partition across directory edges, no reparse junctions, hardlink/ADS unsafe leafs, and non-replay destination derived from handle ancestry. Remote request paths merely match the independently derived destination and cannot choose a new root or traversal. Positive fixture includes two nested directory handles; adversarial cross-volume/replaced-parent/ADS/junction tests fail closed.

For the protected source file and each independently protected ProgramData parent, updater and imported module tree, a mandatory effective DACL snapshot includes inspected handle file ID, owner SID, ACL inheritance status, audited ancestors/descendants, and the actual allow/deny ACE rights mask. Untrusted EFFECTIVE write, append, delete-child, DELETE, DACL/owner mutation and GENERIC_WRITE/ALL are denied, including inherited write ACEs for protected subtrees. Read-only untrusted grants are permitted. Source binary signer and pinned digest remain an additional independent mandatory predicate; ACL alone is insufficient.

**LIMITATION:** This is a source-only *contract*, not a completed native provider; all proof fixtures are synthetic unless explicitly indicated as the separate disposable TEMP read-only CreateFileW tests. No production component collects OS security descriptors and retained native directory handles for this new contract. A fake witness provider can lie; it is not an independently secure OS authority. Atomic handle-relative Win32 write/delete must not be represented as implemented. Existing USB/grant-only native Agent mutations remain denied. Real ACL/installer signer/owner/CORE high-integrity validation remain NO-GO #271/#551. No 1GiB physical file fixture, real USB, Broker/service/UAC/ACL/VM, or user data changed.
