# #41 | Independent self-host coding-worker signing and packaging acceptance QA

**2026-10-23. Status: DRAFT / SPECIFICATION-ONLY / PHYSICAL NO-GO.**
Repository base main: 754cc4364822be5fda528f54042fb22a84f19924. Coordinator #539, epic #780.
#12 PR #804 exact HEAD: 5bff77c424c1c90fd52daf26851cfc8c7ab1310f, exact CI 39841139045 SUCCESS **for docs, not for a signed native worker**. #804 G00–G08 remains the installer owner's canonical acceptance design. #41 is an independent negative QA/evidence ledger, not a parallel installer.

## Inventory and ownership

- src/agent/process-worker.ts: shell/process worker exists, not proof of a distinct non-elevated OS-account/SID coding-worker sandbox.
- src/security/windows-machine-update-tree-trust.ts and windows-privileged-runtime-trust.ts: native read-only audits for privileged machine update, not worker-specific signer, file identity and protected installation.
- src/agent/native-agent-enrollment.ts: existing Agent enrollment, not a separately enrolled worker non-exportable signer.
- Existing test/native-agent-enrollment.test.ts, test/machine-update-protected-tree-preflight.test.ts, and test/windows-privileged-runtime-trust.test.ts are unchanged.
- package.json reports version 1.0.5. Installed Agent 1.0.5, Broker, tasks, production paths, service, UAC, ACL, VM and updater were not queried or modified.
- No verified signed self-host coding-worker production package, native worker signing identity, or external atomic enrollment provider was available for this assessment.

## Independent falsifiable production criteria

| Gate | Trusted native/off-host evidence required | Hard negative and handoff |
| --- | --- | --- |
| Q41-01 Separate worker OS identity | Native token and kernel witness: exact independent worker SID/login session, non-elevated integrity, no Agent/HUB/System/Broker impersonation. Native denied read protected credentials, write signed binaries, duplicate Broker process/Job handles, outside-root filesystem and unauthorized network. Windows Job membership is not a sandbox. | Same SID, high token, inherited environment/handles, unproven native denials: WORKER_OS_ISOLATION_UNVERIFIED. #03/#36/#12 |
| Q41-02 Signed complete package | Independent pinned publisher/issuer, trusted native Authenticode or platform signature for exact opened worker EXE, static/delay/dynamic DLL imports, launcher, updater and rollback binaries. Full dependency and module search-path closure; versioned manifest, SHA-256, volume/file ID, untrusted writable ancestors and symlink/reparse denial immediately before effect. | Swapped, unsigned, unlisted or user-replaceable dependency; changed FileID; rollback signer mismatch: WORKER_RELEASE_UNTRUSTED. #12/#26/#28 |
| Q41-03 Unique per-worker signer | Independently provisioned non-exportable KSP/TPM or platform-bound key, workerDeviceId/owner/host/role/signer generation and enrolled SPKI SHA-256, native key ACL and non-exportability readback. Never reuse Agent/Hub/Guardian/Broker/temp/cloud identity. | Duplicate SPKI across workers or role, exported PKCS#8, forged worker signer: WORKER_KEY_NOT_ENROLLED. #07/#13/#35 |
| Q41-04 Single-use enrollment | Real off-host atomic consume/repair/revoke across two independent Hubs, exact immutable nonce/requestId, signer, ownerEpoch/pairingEpoch, role, host, worker ID and current task/worktree scope. OAuth authenticates owner identity only, not runtime capability. | Duplicate/cloned enrollment, replay under new request ID, forged issuer, stale epoch, missing independent CAS: OWNER_WORKER_ENROLLMENT_UNVERIFIED. #13/#35/#01 |
| Q41-05 Re-pair revoke | Revoke-start barrier before effect, strictly increased externally durable epoch, NEW per-worker key, native descendant stop plus PID/start-time/token readback, post-stop old-key denial across both Hubs and UNKNOWN effect reconciliation. | Old key accepted, checkpoint restore resurrects revoked epoch, ACK lost with replay: RECONCILE_REQUIRED. #01/#08/#13/#35 |
| Q41-06 Secretless checkpoint | Narrow versioned allowlist of identity/epoch/task/worktree/SHA/budget/pendingUnknown/receipt hash references, encrypted/redacted at rest, independent current owner/key/root readback before resume. | Token/password/refresh/private key/raw output/environment secret/replayable grant, corrupt or stale metadata: CHECKPOINT_REJECTED. #34/#08 |
| Q41-07 Downgrade denial | Trusted monotonic signed release sequence and signer generation persisted outside local rollbackable worker state; protocol/Agent compatibility floor; signed updater/rollback pre- and post-cutover. | Even signed older version, locally restored floor, replaced updater/rollback: VERSION_DOWNGRADE_DENIED or RECONCILE_REQUIRED. #12/#28 |
| Q41-08 Physical truth | Authorized disposable lowpriv Windows staging worker only; native signer+file handle+ACL/token/process/network/revoke/restart witnesses and no inherited HIGH/Broker capability. | Only fixture, Node CI, OAuth grant, Job membership, staged manifest or no operator-authorized physical host: PHYSICAL_NO_GO. #12/#16/#36 |

## Source-only isolated negative tests

The new **test/selfhost-worker-signing-packaging-qa.test.ts** contains nine independent test cases. It creates a fresh OS TEMP directory and disposable Ed25519 keys, verifies a signed fixture manifest and per-component content signatures, and attempts: swapped EXE/import DLL, unsigned updater/rollback, injected/missing import, forged publisher, traversal/case alias/symlink/directory, signed version downgrade, cloned worker signer/used nonce/revoked or stale pairing/forged proof, SID/token/handle/secret scope escalation, and checkpoint material leakage.

All fixture writes remain in isolated TEMP and are removed. The crypto keys are **exportable and test-only**, the signatures are **not native Authenticode**, no real Windows token is inspected, no installed code is invoked, and the in-memory enrollment snapshot is **not trusted external CAS**. The synthetic enrollment function never issues an affirmative production grant: a plausible valid input still returns EXTERNAL_CAS_REQUIRED. A clean-looking synthetic OS report still returns PHYSICAL_TOKEN_AND_KERNEL_WITNESS_REQUIRED.

This is **specification and isolated fixture QA**, not shipped production signer coverage, not a production validator and not physical acceptance. A real #12 signing/packaging API and #35 independent admission provider must be integrated by their source owners before negative QA can be used as an actual release gate. #804 G00–G08 must remain BLOCKED until physical witnesses exist.

## Required independent handoffs

1. #12: Publish separately signed worker-only release with independently pinned publisher, transitive imports, updater/rollback, immutable release floor, exact native FileID and protected ancestors. Retarget these tests to that implementation without amending #12 production code here.
2. #03/#36: Supply distinct unprivileged worker token/AppContainer or separately restricted account and read-only native OS, handle, directory and network denial evidence.
3. #07/#13/#35: Supply per-worker non-exportable key and independently consumed atomic one-use enrollment/re-pair revocation across two Hubs. Local fixture Set values do not count.
4. #34/#08/#01: Bind checkpoint redaction, restored stale key denial, UNKNOWN reconciliation and revoke-before-effect to actual immutable worker identity and external authority.
5. #16/#28: Reproduce physical negative readbacks and signed worker-only recovery/downgrade denial before operator-authorized staging. Agent 1.0.5 and HIGH Broker remain untouched.

**Aggregate decision:** workerInstallAllowed:false; workerDispatchAllowed:false; brokerElevated:false; productionApproved:false; physicalAcceptance:NO-GO.

Hosted CI success only certifies repository/test jobs that actually ran. No release or installation approval, elevated grant, native process boundary, D1 mutation, or VM activity is implied.
