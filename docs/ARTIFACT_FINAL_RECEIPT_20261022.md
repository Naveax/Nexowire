# Nexowire #08: Durable Native dispatch ID and authenticated final publish receipt

Date 22 October 2026. DRAFT source-only, #725 parent exact HEAD 09c3dcaf23103b429780c2862c846956058bdcb8, GitHub run 39659633982 SUCCESS. #730 independent unchanged #704 replay exact SHA 7da9f0619ff491ba9c29fd89faf989bf98cacdb4, run 39676785591 SUCCESS.

## Independent review

- #708 (independent #22 two-Hub CAS) current DRAFT head d2eaf951554335a5f4f25ebf9ea3d63c91f38010, based on #725. Unmodified QA file run against exact #725 was 18/21 PASS, with **three stale expected errorCode assertions** expecting generic TRANSFER_PUBLISH_OUTCOME_UNKNOWN while current accepted #725 source appropriately preserves CORE_OWNER_REVOKED, NATIVE_LEASE_EXPIRED, CORE_GRANT_EPOCH_STALE. No test source altered, no unsafe regression to generic error codes. The fixture models signed-looking Native publication receipts but the #08 worker interface previously returned void from publishFenced and then marked COMPLETED.
- #742 (Connection #06 owner) current DRAFT head b93ee12a7737085050768261bff9b4fc71019b65, based on a different Connection lineage. Its owner-epoch, grant generation, device/session epoch, nonce challenge and fresh readback requirements are not a source of #08 dispatch authority. No #06 files copied or modified; cross-module live binding needs #00/#06 acceptance. In particular a read-only reconnect checkpoint is not an authenticated Native completion receipt.

## Real source gap

The hosted #08 worker previously trusted a successful void publishFenced callback and its own staged-file digest to mark COMPLETED. A Native ACK or stale/replayed callback is NOT authenticated proof that the correct job/owner/device/path/epoch was published. A final publication requestId must be durable and idempotence-scoped; an unknown ACK must never cause automatic replay or fabricated COMPLETED.

## Narrow #08 owner implementation

- Introduced FencedFinalReceipt (random durable publication requestId, jobId, accountId, projectId, targetDeviceId, targetPath, bytesTotal, SHA-256, epoch, opaque proof) and a trusted server-bootstrap-only TrustedFinalReceiptVerifier. These are contracts, not a claim of physical signing support on Agent v1.0.5.
- The hosted MCP registration explicitly sets requireAuthenticatedFinalReceipt=true. Without an independent verifier, transfer_start fails closed before any Native write. A user-provided boolean, old Agent success ACK or unsigned payload cannot satisfy the verifier.
- The #08 worker persists a publication journal intent before Native dispatch. The exact requestId is passed to publishFenced. A per-job compare-and-swap flips publication.dispatched=true once only; no duplicate Native publish on restart, lost ACK or later cancel.
- After publish callback, strictly compare immutable receipt fields against the original job/epoch/requestId, independently verify protected signature/attestation via injected verifier, and independently inspect final target file size and SHA-256. Current CORE and external monotonic lease are revalidated after the receipt/readback. Only then can the durable state become COMPLETED. Any void ACK, forged receipt, bad proof, wrong final content, lost publish ACK or stale grant/lease stays MUTATION_UNKNOWN, retaining publication requestId and no-blind-replay.
- Only #08-owned Artifact job/trust/MCP registration and tests changed. Existing stand-alone fixture jobs without the hosted flag retain old test-only dispatch semantics; actual hosted service requires the strict path. The dependency #05 Native writer/signature source is NOT implemented here.

## Deterministic acceptance

- Seven new generated-buffer source tests: missing verifier denies start with zero writes, void ACK cannot complete, foreign requestId cannot complete, forged proof cannot complete, mismatched final destination SHA cannot complete, lost ACK after publication preserves UNKNOWN with exactly one publish, and correctly signed and independently verified receipt plus destination bytes can complete exactly once. **7/7 PASS**. Test-only HMAC key is confined to disposable in-memory fixture, not a physical Agent signer.
- Original single logical MCP transfer_start/status/cancel two sandboxed WebSocket Agents E2E updated to inject test-only independent final signer/verifier; passes with 221KiB+17 bytes. No real connected Agent modified.
- Focused existing Artifact Bridge, owner-journal/CORE, quota, checkpoint, cancellation and E2E suite: **96/96 PASS**. npm run typecheck, npm run build, npm run continuation:check, diff checks PASS on private source worktree.
- #708's current 18/21 source baseline reflects stale generic errorCode expectations only; DO NOT delete or modify independent QA. #730 original #704 transfer cancellation contract CI SUCCESS, not reimplemented here.

## Release decision

SOURCE acceptance above, physical NO-GO. A real trusted Native signer/verifier with independently protected keys and fresh owner/session-epoch, rollback-independent CAS authority #587, Agent #05 native signed atomic writer and >256MiB offsets, #610 real quota receipts, #613/#742 Connection session epoch re-pair and nonce witnesses, #16 independent physical staging, and #00 integration are NOT proven. A signed-looking synthetic receipt is never a release gate. No live Agent/Hub/VM restart, no real 1GiB file, no user-file edits, no production deploy or main merge. Parent #691/#667 remain DRAFT.
