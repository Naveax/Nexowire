# #04 Access — final native image identity and strict CAS-grant timing
**2026-10-22. Isolated source-only child of PR #767. No native execution.**

## Cross-PR contract and CI provenance
- Parent #767 `6967cc92ae85e5d1034591940d273615c4056e00` exact hosted Actions `39803417079`: **SUCCESS**, but all-positive source grants still `canLaunch:false`.
- #764 `12137946976c6cbcf70740e2a3b3737aed427d0c`: the **test-only** `SimulatedExternalCommitAuthority.commitForDispatch` shows revoke-start before final commit must reject, while commit-before-revoke with lost independent side-effect readback is `MUTATION_STATE_UNKNOWN`, **never replay**. First inspection of exact Actions `39803317749`: QUEUED, not claimed SUCCESS. This fixture does not patch #01 owner or deploy an independent CAS.
- #763 `e67f8f4ce14adb161a81f1f1ab45becbf5d7f40c`: native PowerShell import-tree JSON v1 now strictly distinguishes number `1` from string `"1"`, boolean `true`, exponent, array, and malformed import path. Dedicated hosted Actions `39803137184` SUCCESS; full Actions `39803136306` IN_PROGRESS at review. This is **read-only synthetic** ACL evidence, not installed HIGH Broker.
- Existing #712/#731/#747 remain a real source race: old signed reserve may arrive after another Hub starts revoke. Access readback and signed final grant do NOT implement the physical final linearization point.

## Narrow missing Access-owner gap fixed
`src/product/access-final-dispatch-authority.ts` previously bound an externally signed 'final grant' to the proposed launch nonce, owner/device/session epoch, request/dispatch ID and installed Broker PID, creation FILETIME and image SHA. It **did not** require the grant to match the native process *volume serial, file identity and Broker version*, and did not compare the CAS grant's issuance time to the independently signed **latest native launch witness observation**.

This change makes `installedBrokerVolumeSerialHex`, `installedBrokerImageFileIdHex`, and `installedBrokerVersion` strict required signed grant fields and compares their exact values to the independently pinned installed-process identity. It rejects a grant signed even **one millisecond before** the native witness was observed: such a response could be a reservation preceding attestation, not a final native-boundary grant. The original signed permit's expiry, CORE owner/device epoch, current independent CAS and strict ROOT `expiresAt-issuedAt<=900000` are also checked at final proposed launch.

`test/access-late-permit-review.test.ts` adds forged but validly Ed25519-signed mismatch negatives for volume/file ID/version and old grants, plus properly signed malformed JSON (numeric PID encoded as string, owner epoch and generation wrong type, boolean coercion, unknown `externalCommitApproved`, reserve-only state). Both honest core and invalid source outcomes preserve `dispatchEffective:false`, `canLaunch:false`, `canReplay:false`, with no per-command UAC requirement after a legitimate signed one-time enrollment.

## Production P0 block
- The `getFinalExternalGrant` fixture is **not** an implemented `reserve→commitForDispatch` linearizable external service and does **not** prove dispatch-safe authority or immutable readback. Even a correctly signed grant is SOURCE CANDIDATE ONLY.
- #756 same-user `PROCESS_DUP_HANDLE` ALLOW and TEMP PID/FILETIME fixture is not protected installed Broker HIGH token. #271 live inherited Authenticated Users Modify, #551 first-party signed installer/rollback and real imported-module/ancestor effective ACL remain unaccepted.
- Real external CAS revoke-start vs native effect, installed protected Broker high token, ROOT exact 15-minute launch and post-launch UNKNOWN handling must be physically proven by code owners #01/#03; no #01/#03 files were edited.
- No live Broker, UAC, ACL, VM, service, Cloudflare or main branch mutation.
