# NEXOWIRE #06, 2026-10-22: #754 final Native publication receipt and #708 late ACK

**Connection-owned source-only follow-up. Production NO-GO.** No live Agent, VM, ReVoltVPN-Ubuntu-Lab, network, user files, owner Artifact Store or worker code modified.

## Exact provenance and CI triage

- #752 Connection source base: `95bea58abf5be7e0fb4a3c8d7798285423e97573`, full hosted run `39735641942` **SUCCESS (7/7 jobs)**.
- #754 Artifact Native final receipt **exact** HEAD `3a5bf392109d17dbf2650a18398917d5501fd488`, hosted `39736052869`: overall **FAILURE**. Node22, Node24, macOS, Linux native, WSL2, security-operational all **SUCCESS**. Sole red Windows `browser-live` ran `Windows Job fast-exit stdout and stderr are drained before exited status` and failed iteration 6, not a Native receipt/Connection test.
- #708 former QA HEAD `9849b7f122f0842274e4c87bd61dfc1771e05b47`, run `39735289407` overall **FAILURE**. Same sole inherited Windows Job fast-exit assertion iteration 7. All other six jobs, including Node22/24 forged ACK, late-valid ACK, owner CORE revoke and publication provenance QA **SUCCESS**.
- **#708 moved during review** to HEAD `5bb5f3a21b75e748db4fdda322c77e1684b82659`, base changed to #754 exact `3a5bf392...`. New GitHub Actions `39803093211` initially QUEUED. Reading raw #708 HEAD without merging its declared base causes expected type errors (FencedFinalReceipt and publication fields absent). This is not a Connection defect. A disposable merge of #708 + its exact #754 base was produced with `git merge --no-commit`, no push. On this merged QA/source combination, Connection overlay typecheck/build and **84/84** targeted source tests PASS including new stale signed final receipt QA. The raw QA head is NEVER counted as a standalone compilable integration.

## Missing Connection-owned source gap

`src/mcp/cross-device-worker-journal-link.ts` now models **#754 durable `publication` identity**: exact independently generated `requestId`, writer lease `epoch`, SHA-256 and `dispatched`. This record must be persisted/verified by #08; #06 never creates it.

For worker `PUBLISHING` or `COMPLETED` with no pending:
1. Old worker publication absent, malformed, un-dispatched, wrong writer lease epoch or SHA: no independently certified success. `unverified_completion` or `journal_mismatch`, zero replay.
2. Require **two separate trusted injected providers**:
   - `TrustedNativePublicationReceiptReadback.inspect`: independently authenticate #754 signed Native final `FencedFinalReceipt` from protected issuer, not ACK or worker JSON. Bind requestId, job, owner, project, exact target device/path, full total bytes/digest and worker lease epoch.
   - `TrustedPublishedTargetReadback.inspect`: independently read actual published TARGET stat+full SHA, not staged file or metadata. Match exact target device/path, size and digest.
3. After both awaited readbacks, re-check current owner grant and external writer lease, fresh #712 protected nonce-bound ownerEpoch/grantGeneration and independently authenticated Broker WebSocket epoch. A revoke, lease rollover or reconnect during these observations denies before credit.
4. Even correct independent receipts return **`publication_verified_not_committed`**, `checkpointAdvanced:false`, `automaticallyReplayable:false`, `externalSideEffectProven:false`. This adapter never updates #08 or #613 store, does not create a worker dispatch claim, and never marks status COMPLETED.
5. **Existing #752 gap remains closed:** worker `MUTATION_UNKNOWN`, `RECOVERY_REQUIRED` or `FAILED` never gets promoted by a signed-looking late receipt, including two post-WAL reconnects. Both pending missing is still UNKNOWN.

No signed Native publication verifier/independent target readback is actually injected into production in this PR. The HMAC test fixture simulates two independent protected providers; actual Agent v1.0.5 has neither. A method named `verify` from untrusted Agent/caller cannot satisfy the contract.

## Deterministic test evidence

New `test/connection-754-native-publication-readback.test.ts`: nine tests (includes explicit negative and positive observational example).
- exact signed receipt + independent actual target hash => read-only noncommittal proof
- missing/void/un-dispatched publication and missing providers => no success
- **authentically signed**, yet foreign/old Native receipt requestId, epoch, owner, job, project, device, path, size and SHA => deny
- correct original signature but altered/foreign published target bytes => deny
- owner CORE revoke or worker lease rollover while target readback is Promise-gated => deny
- reconnect twice while target readback is blocked => old socket epoch stale, never replay
- orphan UNKNOWN with a valid late receipt remains UNKNOWN; no provider readback used
- malformed publication envelope, lease mismatch and incorrect SHA => fail-closed
- temporary SQLite WAL/FULL journal reopen with publication requestId, two reconnect epochs and owner revoke => UNKNOWN persists, zero final receipt/target readbacks, no effect/replay/credit

Own exact source branch: `npm run typecheck` PASS, `npm run build` PASS, **172/172** selected regressions PASS across 26 files, 0 failures or skips. #754 exact source HEAD temporary compatibility overlay: typecheck/build PASS, **60/60** selected Connection + #754 owner final receipt tests. #708 new HEAD with **declared #754 merge base** in temporary local merge and Connection overlay: typecheck/build PASS, **84/84** selected tests. No owner source edit or push.

## Production release NO-GO

Still missing independent authenticated physical Native signer/publisher/target readback, #587 external monotonic CAS, #712 protected owner epoch oracle without side-effecting dispatch claim, and cross-store atomic checkpoint/final receipt authority. Keep PR DRAFT until new exact-head CI, #08/#22/#16 owner review and physical acceptance. Do not weaken Windows Job fast-exit regression; its independently red hosted runs remain red.
