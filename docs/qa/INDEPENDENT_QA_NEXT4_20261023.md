# Nexowire #16 NEXT4 | current exact SHA acceptance

**23 October 2026**. Main 754cc4364822be5fda528f54042fb22a84f19924 unchanged. GitHub point-in-time search: **246 OPEN PR**, newest #848; coordinator earlier 245/#847 is HISTORICAL, not a current DAG release authorization.

## Current exact head and full CI (final refresh)

| PR | HEAD | Base | Full run | Full result | Key evidence |
|---|---|---|---|---|---|
| #826 | ba21955cedc7 | 3dc5f12fdbf7 | [#39938851608](https://github.com/Naveax/Nexowire/actions/runs/39938851608) | FAILURE | CURRENT FAIL_CLOSED_NATIVE_ADMISSION_18_LEGACY_POSITIVES_AND_WINDOWS_STREAMS |
| #847 | 79fdecf348b5 | 661d817fbefc | [#39914505805](https://github.com/Naveax/Nexowire/actions/runs/39914505805) | FAILURE | REAL_REPRODUCED_NATIVE_GRAPH_DISPATCH_BYPASS |
| #811 | daa166e42f94 | 754cc4364822 | [#39939395440](https://github.com/Naveax/Nexowire/actions/runs/39939395440) | FAILURE | CURRENT_NODE22_NODE24_SOURCE_SUCCESS_BUT_WINDOWS_JOB_STDOUT_EARLY_EXIT_RED |
| #845 | 6b16de921ce0 | 600a0286557d | [#39868037273](https://github.com/Naveax/Nexowire/actions/runs/39868037273) | FAILURE | REAL_OLD_BASE_GIT_NESTED_COMMITGRAPH_SYMLINK_NEGATIVE |
| #829 | 571540214296 | 7bc16b4cd101 | [#39863445519](https://github.com/Naveax/Nexowire/actions/runs/39863445519) | SUCCESS | ALL_SEVEN_HOSTED_CI_JOBS_GREEN_SOURCE_ONLY |

**Historical superseded commits, never current:** #826 aabc75fd CI 39914532851 FAILED 18 old positives; #811 f7a8fae CI 39913730567 **7/7 SUCCESS** source only. Those exact historical results remain in the machine-readable evidence. No stale green.

## Genuine source negatives versus independent Windows and compatibility failures

- **#826 current ba21955 run 39938851608:** Node24 18 legacy positive graph/private runbook/artifact/persistence cases blocked by correctly fail-closed missing trusted external native admission (RunbookAdmissionRequiredError). This is source integration compatibility red, **not license to disable guard**. Separately Windows browser-live job 120365021186 fails separate stdout/stderr pipe capture missing WINJOB_STDOUT, a Windows regression. Node22 cancelled.
- **#847 current 79fdecf run 39914505805:** hostile direct graph RED test produced **two external marker subprocesses** after cloned original UNKNOWN without trusted off-host CAS, expected ZERO, exposing true real native dispatch admission bypass. Four other old private/runbook positives fail. Node24 RED; Windows browser-live green does not clear violation.
- **#811 current daa166e run 39939395440:** Node22+Node24 source SUCCESS, but browser-live Windows Job fast-exit announces exited before stdout captured at iteration ZERO (120367127511), so **full CI FAILURE**. Earlier f7a8fae 7/7 full CI success was a different prior SHA. This is not physical installed HIGH Broker/ACL acceptance or proof #845 hostile old-base test passed on current #811.
- **#845 current 6b16de9 run 39868037273:** OLD BASE 600a028; nested .git commit-graph file symlink outside approved task root not rejected before Git subprocess, true source P1 sandbox RED. Separate Windows structured network/service/process JSON PowerShell timeout after 45000ms; Node22 cancelled. Old-base failure does NOT show latest #811 new HEAD red or green under the unchanged hostile test.
- **#829 current 5715402 run 39863445519:** all 7 hosted CI SUCCESS + separate QA03 NWJOB5 early output workflow 39863445634 SUCCESS, both source/hosted only. Live installed Agent/Broker, local UAC, native effect and physical two-device acceptance NOT tested.

## Original R01–R22 P0 Source/Staging/Production/Original incident

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED; staging, production and original incident **all 22/22 BLOCKED**. Mandatory P0 tests unchanged.

| Requirement | Source | Staging | Production | Original incident |
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

## Independent P1 #780 acceptance

| Feature | Source | Staging | Production |
|---|---|---|---|
| P1-INV | NOT_TESTED | BLOCKED | BLOCKED |
| P1-DIFF | NOT_TESTED | BLOCKED | BLOCKED |
| P1-SANDBOX | FAIL | BLOCKED | BLOCKED |
| P1-LOOP | NOT_TESTED | BLOCKED | BLOCKED |
| P1-CKPT | NOT_TESTED | BLOCKED | BLOCKED |

P1-SANDBOX source FAIL remains from unchanged hostile tests (#800 earlier, #845 old base); latest #811 source test pass does not waive physical or unchanged cross-branch adversarial replay requirement. Other four P1 features NOT_TESTED.

## Real physical release NO-GO remains

- #587 rollback-independent non-co-restorable atomic CAS before ANY direct graph/runbook native dispatch. #847 two marker subprocesses show a bypass when absent; #826 old positives must be reconciled without weakening fail-closed admission.
- #271 installed protected ACL; #551 first-party signed installed HIGH Broker/local owner-approved UAC/full rollback; #588 independently authenticated final SHA/requestId/current owner epoch native publication; #617 typed elevated exact Hyper-V VM GUID and trusted Running readback ALL unverified.
- #31 should rerun unchanged hostile nested commitgraph #845 and earlier #821 clean, #839 process, #814 linked metadata against latest #811 SHA. Actual no-spawn source proof first, then separate physical environment acceptance.
- #829 Windows NWJOB5 source green cannot prove physical Agent1.0.5. #811 latest Windows fast-exit source red remains.

No live Agent/VM/UAC/ACL, no true production data or main merges. ReVoltVPN-Ubuntu-Lab untouched. Historical NEXT2 QA evidence and mandatory R01–R22 source negatives byte-identical. **PRODUCTION NO-GO.**
