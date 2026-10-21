# Nexowire #08 cross-Hub writer fencing and 221KiB receipt acceptance

Date: 21 October 2026. Branch: feat/08-mutation-fence-20261021. Source-only DRAFT, never deploy from this branch.

## Verified baseline and review

- PR #596 OPEN/DRAFT, exact head 335046569a38f3a1a3fc82bf851f9b7df7640fdb, GitHub run 39557944551 SUCCESS.
- PR #616 OPEN/DRAFT, exact head 94b92e01219aca3cd4ca86775fe4b61a72ac53c4, GitHub run 39598755514 SUCCESS.
- Issue #587 journal+authority co-rollback P0 remains unresolved, so local JSON, SQLite or host PID lease is NOT trusted external monotonic CAS.
- #601 is MERGED and provides staging quota cancellation/tombstone; #610 OPEN/DRAFT adds independent receipt verifier to reject forged durableStorageVerified, durableDeletionVerified, writersStoppedVerified flags. It is NOT production-wired.
- #605 is MERGED to main 4c5c810134c020cd04a5ef2be5c1138ea1954ad0, and is a connection-layer reconciliation state machine; #613 OPEN/DRAFT requires current owner/project/device grant authority for each transition. Neither a connection ACK nor source-only callback is a physical write receipt.
- Isolated #08 worktree started from #616 and merged the currently verified main ONLY into the private branch to compile against #605. No modifications to #587, #601/#610, #605/#613 owned files, and no changes to running devices/services.

## New fail-closed source behavior

- Server-injected TrustedTransferCoreGrants MUST check effective current CORE delegation bound to authenticated owner, both devices and project. Checks occur before Native source stat/hash at start, on explicit resume, on status/cancel, before and after EACH native write/readback, and before publish.
- Server-injected TrustedTransferAuthority MUST provide external monotonic epoch+token with independent anti-rollback trust. Higher epoch is required for explicit resume, and the authority is consulted before every mutation and final publish. User-supplied fields cannot provision either authority.
- Hosted transfer_start CANNOT fall back to legacy Agent 1.0.5 files.write/write_at. It requires a trusted Native atomic writer implementing writeFenced(job, requestId, epoch, token, exactOffset, len, sha256, content) and publishFenced. The callback is a trusted Hub-bootstrap entrypoint, not MCP args. No actual Native v1.0.5 provider is configured, therefore hosted physical write remains BLOCKED rather than pretending software-only locks are sufficient.
- Strict job persists one immutable pending requestId, epoch, offset, length and SHA BEFORE dispatch. Native receipt must match exact persisted requestId/epoch/offset/len/SHA and cannot by itself advance offset. Independently read back the exact staged destination byte range, verify strict canonical Base64, chunk SHA and target file length, then recheck current CORE and external epoch before durable confirmed byte CAS. Forged receipt, spoofed same-size payload, revoked grant or lost ACK retains a pending UNKNOWN mutation; it is never automatically replayed.
- Explicit resume first obtains the higher independently granted epoch, then reconciles the existing target stage prefix hash and source full digest. If pending mutation exists but stage vanished, it fails closed. Stale origin worker cannot publish with old epoch when actual Native fencing is implemented.
- Cross-chat VerifiedTransferCheckpointAdapter now demands CURRENT owner CORE grants for persisting or retrieving previous checkpoints, in addition to exact verified content-addressed manifest, SHA, size, repository, commit and account/project/target-device identity. It does not give ChatGPT implicit access to temporary files from another conversation.
- #610 quota receipts remain a different DRAFT source contract; no invented authoritative physical deletion, writer-stopped witness or quota-refund success was accepted here. #613 source remains its own DRAFT, not merged into this branch.

## 221 KiB synthetic acceptance

Fixture: exactly 226,304 binary bytes, each byte generated as (index * 13 + 29) modulo 256. Source SHA-256:
c8fdfa243e97a7dac15d25c314984d146dc723caf5261f34f06bf2175e801f5a

SOURCE: 126/126 selected tests PASS, typecheck/build/continuation PASS. SYNTHETIC UNIT: 4 x 64KiB-or-smaller chunks; exact offset/epoch/native receipt + independently read-back staging. Final SHA and bytes matched. Negative tests include forged SHA receipt, same-length destination byte tamper, lost ACK after first Native mutation followed by explicit new-Hub resume with NO duplicate first write, owner CORE revoke between write and readback preventing progress and publication, absence of Native fenced provider, and grant revoked before ANY source stat/hash call.

ISOLATED STAGING: Previous two sandboxed WebSocket Agent test retains one logical MCP transfer_start/status/cancel and a 226,321 byte (221KiB+17) synthetic fixture; its Native fenced writer is explicitly a TEST-ONLY emulator using disposable sandbox paths, not a shipped Agent feature.

PHYSICAL: NO new live Work PC/Naveax file transfer this turn, NO 1GiB fixture. Both actual Agents were last observed as 1.0.5; Native greater-than-256MiB read/write/hash and effective low-level CAS epoch support unproven.

PRODUCTION NO-GO: Actual independently authenticated external monotonic CAS authority (#587), Native atomic fenced exact-offset chunk writer (#05), owner CORE grant/revocation trusted online provider and signed Agent canary, real #610 receipt verifier + #601 quota/cancel source, #605/#613 route epoch/ACK reconciliation integration, independent multi-Hub WAL co-rollback and real staging/TLS (#16/#00) acceptance remain BLOCKED. Tests of a mock do not verify Cloudflare D1, production billing, physical rollback or Agent 1.0.5 atomic fences.

## Workstream boundaries

Only own Artifact Store/job, MCP registration and adapter tests were modified; original #597 QA contract stays unchanged. Live Hub/Agent not restarted, production not deployed, main not merged and no user file deleted or overwritten.
