# #02 cross-owner negative acceptance against #741 / #743 / #712

Date: 2026-10-22. **Existing DRAFT #727**. This is #02-only source reconciliation, not a merge of or edit to the Access, native Broker, or dispatch-owner implementation.

## Exact GitHub evidence

- #727 `c0fb307fe9198dff1a85b5f375524a5b6107fe7a`: independent hosted serial Windows DPAPI QA [#39677239164](https://github.com/Naveax/Nexowire/actions/runs/39677239164) **SUCCESS**. Full CI [#39677239175](https://github.com/Naveax/Nexowire/actions/runs/39677239175) **FAILURE overall**: six jobs SUCCESS, **macos-agent-lifecycle-live CANCELLED**; Node22, Node24, browser-live Windows, Linux-native, WSL, security jobs SUCCESS. No false 7/7 CI claim, no assertion of a macOS test failure.
- #741 Access nonce source `5c2b39530937f7a929044f1be3f6fb9ad89d8ff8`, CI [#39677981833](https://github.com/Naveax/Nexowire/actions/runs/39677981833) **SUCCESS**.
- #743 native Broker / QA17 / QA19 combined source `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`, [full CI #39678489196](https://github.com/Naveax/Nexowire/actions/runs/39678489196) **SUCCESS**, [dedicated QA #39678489269](https://github.com/Naveax/Nexowire/actions/runs/39678489269) SUCCESS.
- #712 external dispatch nonce and ownerEpoch source `1d78a7a9174e91e3b6baaa1319a063917391a64f`, [full CI #39676838080](https://github.com/Naveax/Nexowire/actions/runs/39676838080) **SUCCESS**.

## Independent owner separation: what is and is NOT an effect

**#741** `src/product/access-queued-job-review.ts` requires a new random 32-byte `challengeNonce`, independently signed protected installed Broker statement, signed CAS readback with same nonce, current owner/device/session/ownerEpoch/grantGeneration and monotonic high-water. Its only accepted gate output is `REVIEWED_ONLY_NO_DISPATCH`, not an execution receipt. Native signed claims are also not independent physical token checks until the protected installed Broker/signer is actually provisioned.

**#743** tests source-only read-only native Windows protected EXE+import/updater tree, ancestor DACL and PID/Win32 creation FILETIME and 100-cycle Job pipe capture. It explicitly does NOT independently prove complete transitive imports, actual effective ACL AccessCheck, physical installed signed high-token Broker, or a VM postcondition. Signed-looking tree paths or the inspecting PowerShell's own high token cannot be laundered into authority.

**#712** validates short-lived, nonce-bound, signed, atomically single-use `beginIfCurrent` dispatch permits, exact current ownerEpoch/device/session/fingerprint and revoke-drain fencing. A validly signed remote CAS permit is **authorization to potentially dispatch**, not independent proof that a native command finished or that a VM transitioned. Its external authority in tests is synthetic/loopback, not a physically deployed immutable off-host CAS.

## Narrow QA source fixes / negative acceptance

- `src/protocol/elevated-outcome-error-contract.ts` (owned by #02, not wired into a command path) now explicitly returns `ACK_TRANSPORT_UNCONFIRMED` for negative ACK and `POSTCONDITION_NOT_APPLICABLE` if someone offers `vmState:Running` as proof of a shell command. **Both still return `MUTATION_STATE_UNKNOWN`, `reconcile_first`, no replay and `effectVerified:false`**. No execution-success path exists.
- New `test/qa-02-access-native-cas-cross-owner-negative.test.ts`: six cases cover injected forged Access nonce/CAS signature, synthetic native protected-tree flags and own-token High, forged external dispatch permits and restored owner epoch, lost ACK, wrong owner or old VM readback, and physical UAC spoof. The strict schemas reject third-party claims as input; even all-positive source-only fields cannot confirm a physical postcondition. Real owner implementation files are never imported or edited; their exact SHA and source interfaces were inspected separately.
- Existing #661/#683/#727 crash-persistent requestId/operationId `UNKNOWN`, external reconciliation only, forged consent, and no-replay tests remain unchanged. The QA-specific serial Windows DPAPI workflow simply appends the new source-negative test to its list, without modifying existing failing DPAPI files or full CI.
- Local latest focused **32/32 PASS**, typecheck PASS. The new commit's broader local suite and GitHub exact-head CI must be recorded separately.

**Release gate remains P0 NO-GO**: one-time physical UAC, signed and protected installed HIGH Broker with separately authenticated ownerEpoch, real external rollback-independent CAS, fresh nonce-bound physical command/VM effect readback and full ACL/import tree all absent as production acceptance. No live UAC, VM, shell, ACL, Agent, Broker, or ReVoltVPN-Ubuntu-Lab activity; main untouched.
