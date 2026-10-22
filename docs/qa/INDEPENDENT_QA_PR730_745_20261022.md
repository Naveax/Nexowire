# Nexowire #16 | PR #730–#745 independent QA acceptance

**22 October 2026 | Current main pinned:** 754cc4364822be5fda528f54042fb22a84f19924. QA documentation only; parent source DRAFT #744. No source/workflow/test or physical production mutation.

## Exact HEAD and CI review

Latest exact SHA: **13 full CI SUCCESS / 3 FAILURE / zero pending**. Earlier 11 SUCCESS/5 FAIL and then 12 SUCCESS/3 FAIL/1 pending snapshots belonged to earlier #732/#735 HEAD or workflow states. Each branch HEAD is distinct from main and other owners. One PR (#737) is CLOSED with its last exact-head CI FAILURE; closed is not automatically merged or green. Earlier #744 CI cannot be cleared from #743 independent source jobs.

| PR | Exact HEAD | Base HEAD | Run | Overall | Detail |
|---|---|---|---|---|---|
| #730 | 7da9f0619ff4 | 09c3dcaf2310 | 39676785591 | PASS | Replays unchanged #640/#651/#677/#704 against #725 Artifact cancel source; whole CI SUCCESS, but real native write/ACK physically unverified |
| #731 | df239ce88f4b | 1d78a7a9174e | 39676999169 | PASS | Two-Hub revokeAndDrain late signed permit and external CAS fixture source success, not independently deployed monotonic witness |
| #732 | 9014449ef9f3 | aec8a331ab6e | 39735234697 | PASS | CURRENT exact HEAD 9014449e complete full CI 39735234697 SUCCESS, signed Agent 1.0.5 rollback source only. Prior ea5f1f macOS job CANCELLED full CI FAILED is historical and not current. |
| #733 | 0f7c6af824c2 | b083004b9ab8 | 39677163113 | PASS | Protected-tree #709 Broker FILETIME/CAS hostile source checks green, not running physical signed HIGH Broker |
| #734 | 5e2482bfe7cc | b083004b9ab8 | 39677224071 | PASS | Full CI SUCCESS plus independent QA19 Windows workflow 39677224212 SUCCESS; protected-tree fixture/100cycle source only |
| #735 | d4c35e2a7ade | f730943fb239 | 39735083325 | PASS | CURRENT exact-head CI SUCCESS; PRIOR 5a2d1c TS18047/TS2339 full CI FAIL historical only. |
| #736 | c68c561dae9a | 52d13f432709 | 39677383239 | PASS | AI Screen child emergency-stop source fix green, no live GUI or privileged UAC |
| #737 | ea016f7d6165 | 1ef44efc7b14 | 39677569353 | FAIL | Windows Job stdout/stderr independent pipes fixture FAIL: WINJOB_STDOUT not captured; PR now CLOSED, do not claim merged or green |
| #738 | ce85d257c2f0 | 38dfb89a9a75 | 39677587592 | PASS | Four 9.5MiB gzip parser vs 64 quiet tenant and pending receipt source; no actual production WSS capacity |
| #739 | aec8a331ab6e | d7e5f98b5b28 | 39677691555 | PASS | Signed owner epoch and nonce permit binds CORE importer ACL source, no physical first-party installer or protected live tree |
| #740 | 8b17168e6102 | 0ca5903fae85 | 39677694668 | PASS | Two-Hub external CAS Access revoke/readback UNKNOWN QA source, not rollback-independent physically provisioned storage |
| #741 | 5c2b39530937 | 597191102dab | 39677981833 | PASS | Nonce-bound protected Broker and owner CAS epoch under CORE/ROOT source, cannot attest actual HIGH token |
| #742 | b93ee12a7737 | 13cef903130d | 39678274991 | PASS | Connection double reconnect forensic UNKNOWN and epoch fence source PASS; no live Agent or independent effect readback |
| #743 | 7bc16b4cd101 | b083004b9ab8 | 39678489196 | PASS | CI SUCCESS + QA17 39678489203 and QA03 Windows integration 39678489269 SUCCESS, replays protected tree source only, not production Broker |
| #744 | c9e0e93a9b8a | 064e59b2640d | 39678517442 | FAIL | Dedicated mandatory P0 RED 7 true source gates, separate Windows durable /NW_DURABLE_READY/ reattach timeout, generic Node24 required gate failure and Node22 CANCELLED; do not delete tests |
| #745 | 8a4722341355 | d7e5f98b5b28 | 39733783135 | FAIL | Windows Job stdout/stderr drained before exited FAIL at iteration5; other 6 sibling jobs green, signed installer rollback source not physical |

## Three current FULL CI failures, and two superseded historical failures

- **#732 new HEAD SUCCESS; prior macOS cancellation historical:** OLD ea5f1f CI 39677044173 FAILED when required macOS lifecycle job CANCELLED. NEW HEAD 9014449e CI 39735234697 SUCCESS source only. No production signed installer/rollback or high token proof.
- **#735 superseded historical TypeScript regression:** OLD HEAD 5a2d1c / CI 39677340744 FAILED TS18047 (addr null) and TS2339 (AddressInfo.port) at single-slot-close-admission.test.ts:74. NEW HEAD d4c35e2a7a / CI 39735083325 SUCCESS source only. The historical bug is recorded, not attributed to current commit.
- **#737 Windows separate streams:** CLOSED draft last CI 39677569353 FAIL. Windows Job separate stdin/stdout/stderr pipe test expected WINJOB_STDOUT but observed empty; source issue remains on that exact branch.
- **#744 mandatory P0 RED plus Windows reattach:** run 39678517442 FAILURE: dedicated qa-independent-negative-acceptance job 119494574854 correctly FAILS seven source production contracts. They remain NONOPTIONAL: ROOT 15-minute signed lease issue-time bound, broad REAL Windows HIGH signed CORE executor, separately privileged authenticated signed Broker shell registration, typed Hyper-V vm.start currently STANDARD and absent scoped VM GUID Broker permit, #587 restored old journal accepts already-completed requestId, #588 onecall durable transfer start/status/cancel not advertised on main. Separately browser-live job 119494574903 fails Windows durable ProcessManager /NW_DURABLE_READY/ readback in 27.3sec; Node24 generic suite also fails required gates, Node22 cancelled. Do not call this all intentional or all an infrastructure flake.
- **#745 Windows Job fast-exit:** run 39733783135 full CI FAIL in browser-live job 119674644929 because stdout not drained before status exited, iteration 5, despite six other green jobs. True Windows Job output/order regression.

## Positive source evidence stays source only

- #730 (#725 cross-branch unchanged Artifact cancel tests), #731 and #740 (external CAS revoke after stalled permit), #733/#734/#743 (protected Win32 image/import/FILETIME tests and independent Windows QA), #739/#741 (signed CORE owner epoch/nonce) and #742 (forensic reconnect UNKNOWN) all have completed full CI SUCCESS on their own HEADs.
- #734 separate QA19 Windows CI 39677224212 SUCCESS alongside ordinary 39677224071 SUCCESS. #743 full CI 39678489196 plus QA17 39678489203 plus Windows integration QA03 39678489269 all SUCCESS. None proves the installed signed Broker, kernel HIGH token and immutable importer/ancestor ACL or independently attested external monotonic owner epoch.
- #736 AI Screen safety and #738 bounded 4x9.5MiB gzip tenant fairness source green; not live secure desktop, 100+ WSS or physical 1GiB Agent transfer.

## R01–R22 four-level acceptance

Source **6 PASS, 6 FAIL, 9 BLOCKED, 1 NOT_TESTED**; all 22 staging, production and original incident BLOCKED.

| R | Source | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R02 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R04 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R05 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R08 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 | NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R14 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R16 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 | FAIL | BLOCKED | BLOCKED | BLOCKED |

## Physical production NO-GO gates

- CORE goal is persistent revocable real broad Windows HIGH-integrity administrative shell/process, never SAFE alias. Legitimate first LOCAL owner-approved UAC signed protected Broker bootstrap, then no per-command UAC after valid enrollment. ROOT real elevated <=15minutes with trusted issuedAt and revoke/re-pair/current signed owner device-session epoch; FULL standard Windows token.
- **#271 actual ACL**: historical live Naveax Agent legacy stack EXE/CLI inherited Authenticated Users Modify; independent signed native Broker/exe plus all imported DLL, updater, ancestor ACL/effective signer/hash/PID+creation FILETIME still not physically trusted.
- **#551 genuine signed bootstrap**: no verified first-party Nexowire signed protected installer, approved local UAC, complete signed old Agent1.0.5 rollback and Windows VM/two-device canary. Staged feature-branch CI cannot substitute for native OS evidence.
- **#587 rollback independent witness**: local restored J+A authority permits old completed requestId; no independently hosted non-co-restorable monotonic CAS owner/device/epoch reserve/revoke and signed physical postcondition. After possible Native effect, lost ACK remains UNKNOWN, no blind retry.
- **#588 onecall durable public API**: scoped authenticated transfer_start/status/cancel missing on pinned main, no signed actual 1GiB two-device durable postcondition.
- Hyper-V vm.start currently standard source classification where elevated typed/signed VM GUID permit is necessary; no independently authenticated exact VM GUID Running/Off readback. **ReVoltVPN-Ubuntu-Lab untouched**, no Start-VM or UAC manipulation.

## QA provenance and file scope

- Source-only docs modified: cross-project-final-acceptance.json plus new QA_20261022_PR730_745_EXACT_HEAD.json and this report. Existing historical 138-entry QA ledger, 44 findings and all prior QA tests/workflow remain byte-unchanged. New 16 exact-head records are separate supplemental evidence; no fabricated aggregate stable open-PR count.
- Every source PASS is limited to its exact PR HEAD and CI run; no full live ACL/UAC/Agent/Broker/Cloudflare/VM, no main merge, no skipped source-red tests. #744 all seven deliberately failing P0 contract tests and the independently failing Windows Job tests remain active.

**FINAL RELEASE: PRODUCTION NO-GO**.
