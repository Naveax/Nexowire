# Nexowire #08: unresolved Native publication can never be re-queued on reconnect

Date: 22 October 2026. Source-only independent DRAFT owner follow-up, base #768 exact HEAD 00ad9a4f061a4da2a0215e470b302f1e25950e4e.

## Review and provenance

- #768 GitHub Actions 39803672615 was QUEUED at last previous check; on new review its Node22/24, macOS, Linux and security jobs completed SUCCESS, while WSL2/browser pending. No duplicate CI was triggered.
- #770 Connection HEAD 131d96cdab40a68f0b12c6991d330e9d62573bf0: independent final Native receipt plus target readback is explicitly observational, state publication_verified_not_committed, checkpointAdvanced=false, automaticallyReplayable=false and externalSideEffectProven=false. #770 exact detached source branch new publication and forensic Connection tests **19/19 PASS**, unchanged; no #06 source modified.
- #708 currently HEAD e99a611cc4ea7a230f5812f003f4789d2fd6f727, base #768. Original test/qa22-crosshub-cas-fencing.test.ts loaded byte-identically from QA branch in owner worktree: **26/26 PASS** after fix. No #22 QA edits.
- #762 HEAD 9709bfe2250dd2fec6a65937dd2059ee66be39f3, CI 39803019258 SUCCESS on its declared old #754 base. Its original three QA cases were separately replayed UNMODIFIED against the stricter #768 exact source, and all three failed at expected start admission EXTERNAL_PUBLICATION_COMMIT_REQUIRED because their synthetic external authority omits mandatory commitPublished. No downgrade to accept a forged or local-only authority. #21 QA owner needs to update fixtures/contracts on own branch, not source. The cross-review combined #762+#708: 26/29 passed, 3 unsupported old-contract fixtures.
- #718 quota safety (DRAFT) requires protected independent Native dispatch high-water, authoritative writer-stop/deletion receipts and explicit publication disposition / durablePublicationCommitId. Neither a signed-looking Native ACK nor this worker's PUBLISHING/MUTATION_UNKNOWN status may mint a quota release or final billing credit. #08 owner source has no quota-releasing callback or evidence of end-to-end physical #718 integration. Do not claim a real quota refund mechanism was tested in this branch.

## Actual additional #08 production gap reproduced RED

On base #768, an authentic Native publication may have executed and its ACK or off-host atomic completion confirmation may have been lost. The worker correctly records publication.dispatched=true, state MUTATION_UNKNOWN, errorCode=TRANSFER_PUBLISH_OUTCOME_UNKNOWN and no durableCommitId. HOWEVER explicit start({resumeTransferId}) against a new Hub was allowed to acquire a higher epoch, reconcile an intact staged prefix, clear forensic error and change the job to QUEUED. The old publication guard eventually blocks a second publish, but UNKNOWN temporarily disappeared and a worker/source read can run again. A reconnect/checkpoint/quota consumer could see a false healthy state.

New deterministic source-only test replays a lost Native PUBLISH ACK (one actual synthetic publication, a durable publication requestId, full stage and target bytes), then explicitly resumes from a different Hub with a higher-epoch authority available. On exact original #768 it was **RED**: 'Missing expected rejection'; initial worker attempted a new async execution until fixture teardown. No 1GiB, Native service or external network was used.

## Minimal owner fix

Only src/mcp/cross-device-transfer-jobs.ts adds an early gate in explicit resume after exact owner/project/devices/paths + live CORE check, BEFORE acquiring new external writer epoch or reading source/stage. If any previous publication intent exists and journal is not COMPLETED, fail TRANSFER_PUBLICATION_UNRESOLVED. Never clear original publication requestId/epoch/SHA/dispatched or errorCode, never mark QUEUED, never re-send Native publish. This also preserves conservative UNKNOWN if external commit succeeded but local COMPLETED journal write or ACK was lost; an independent operator reconciliation and off-host monotonic proof is required for recovery.

Updated owner test/artifact-08-final-native-receipt.test.ts checks exact negative error, new-Hub no lease acquisition/no further stage or source read, durable status remains MUTATION_UNKNOWN and publication identity unchanged, no second Native publish and no invented durableCommitId. Test **RED baseline -> PASS fixed**.

## Local acceptance, physical NO-GO

- Current #08 + latest original #708 two-Hub QA 126/126 PASS, typecheck/build/continuation PASS; independent #770 Connection 19/19 PASS on its own source.
- #762 source compatibility RED due stale test fixture missing mandatory independent external commit, **not** accepted by weakening the security gate. Original QA files are not committed to this PR.
- Real #587 independently authoritative monotonic CAS/final commit, #05 signed Native fenced writer/target publisher, #610/#718 immutable quota refund and admission witness, #613/#742/#770 Broker owner/session epoch and protected readback, #16 physical staging and #00 deployment remain NO-GO.
- No physical >256MiB/1GiB transfer, no live Agent 1.0.5/Hub/VM restart, no user files changed, no production deployment or main merge.
