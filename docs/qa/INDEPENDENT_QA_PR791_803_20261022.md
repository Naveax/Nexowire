# Nexowire #16 | #791–#803 exact HEAD, P0/P1 independent QA acceptance

22 October 2026. Pinned main 754cc4364822be5fda528f54042fb22a84f19924. QA-only, no production merge.

## All 13 PR exact HEAD full CI

8 FULL SUCCESS, 5 FULL FAILURE, 0 pending or unknown. Green source CI does not confer native physical permissions or merge safety.

| PR | Exact HEAD | Base | Run | Full CI | Red meaning |
|---|---|---|---|---|---|
| #791 | 22eec6de2426 | 89a865363829 | 39821808832 | FAILURE | WINDOWS_JOB_STDOUT_ORDER |
| #792 | 11ac2b320b4b | 1e41df6cfc60 | 39822548339 | FAILURE | WINDOWS_JOB_STDOUT_ORDER |
| #793 | 9f24e7e11301 | 7927adefbbef | 39822912875 | SUCCESS | QA_DOC_SOURCE_GREEN |
| #794 | 765f59f1d7c5 | 0fab0d7eab6f | 39823178271 | SUCCESS | SOURCE_NEGATIVE_QA_GREEN |
| #795 | 70e9735007b6 | 3fe56ef39ab6 | 39823364109 | SUCCESS | SOURCE_NEGATIVE_QA_GREEN |
| #796 | 8feda580d339 | 131d96cdab40 | 39823465153 | SUCCESS | SOURCE_NEGATIVE_QA_GREEN |
| #797 | 9e75943adc86 | e7e46b970dd9 | 39823465809 | SUCCESS | SOURCE_FIX_CI_GREEN_ONLY |
| #798 | 825bca693d02 | df145abbc7b2 | 39823472405 | SUCCESS | QA_DOC_SOURCE_GREEN |
| #799 | 7e3d1df52a0d | e7e46b970dd9 | 39823529140 | FAILURE | WINDOWS_JOB_STDOUT_ORDER |
| #800 | 6eb562cffd68 | 754cc4364822 | 39823730640 | FAILURE | REPRODUCED_REAL_P1_SANDBOX_DEFECT |
| #801 | 6742ddfceb34 | ade5526b69b0 | 39823885977 | SUCCESS | SOURCE_QA_GREEN_NOT_FEATURE_ACCEPTED |
| #802 | 12c7511bdeb9 | bc9eba3a57ce | 39824624827 | FAILURE | SEVEN_MANDATORY_P0_PLUS_DURABLE |
| #803 | 7fa4bdc65c5f | a038d8f8dc3b | 39824845400 | SUCCESS | QA_DAG_SOURCE_GREEN_NO_MERGE |

## Failures and true negative reproduction

- #791 browser-live job 119975219942: Windows Job exited before stdout drained, iteration 6. This does NOT demonstrate cloned UNKNOWN double-charge source defect on #791.
- #792 browser-live job 119978909279: same Windows fast-exit stdout ordering regression, iteration 11. OAuth strict owner principal source feature not independently failed.
- #799 browser-live job 119980694018: same Windows Job output ordering, iteration 10. Source high-water CAS negative not independently failed.
- #800 Node24 job 119981387012: REAL workspace.snapshot executes repository-controlled Git core.fsmonitor hook outside authorized PathPolicy root; test/p20-780-git-fsmonitor-hook-escape-negative.test.ts:96 FAIL. Genuine source P1 sandbox failure, not unrelated hosted red.
- #802 exact CI 39824624827 FAIL: Node24 npm check fails SAME seven mandatory original P0 missing contracts, dedicated independent P0 job 119984527813 FAILED; separate Windows durable ProcessManager NW_DURABLE_READY timeout 27.884s in browser-live job 119984527847. Node22 CANCELLED, other hosted four SUCCESS. No distinct TS syntax failure proved.

## Other independent real source regressions

| PR | HEAD | CI | Confirmed source negative |
|---|---|---|---|
| #708 | 36b443ef300d | 39824007092 FAILURE | Missing expected rejection: cloned UNKNOWN borrowed final CAS across Hub A and revoke-start before checkpoint save |
| #726 | 50491525249b | 39823764746 FAILURE | #787 stale owner epoch/early all-green snapshot incorrectly renders CORE effective/persistent without current epoch and physical HIGH/native CAS |
| #800 | 6eb562cffd68 | 39823730640 FAILURE | workspace.snapshot executes repository controlled core.fsmonitor hook and writes outside scoped taskRoot |

- #708 Node22 job 119982616074 actually fails cloned UNKNOWN borrowing final CAS and missing Hub A revoke-start rejection, Missing expected rejection at test/qa22-crosshub-cas-fencing.test.ts:1560. This is genuine P0 CAS negative reproduction.
- #726 Node24 job 119981513248 actually fails CORE stale ownerEpoch/early snapshot misrepresented as EFFECTIVE/persistent at test/qa/core-card-approval-pref-only.test.ts. Genuine P0 status UI negative reproduction.
- #800 Node24 root escape via Git fsmonitor is a genuine P1 source isolation failure, not only a CI host problem.

## #803 SUCCESS does NOT license merge

#803 HEAD 7fa4bdc65c5f59c09179d3afa3fb896c4280aa87 CI 39824845400 SUCCESS is scoped QA24 DAG/source evidence. It does not waive #708/#726/#800 real RED source findings, Windows Job failures, old owner grants, protected Broker, #271/#551/#587/#588 physical evidence, merge conflict or stale base. Main merge list remains empty without independent exact-current checks.

## R01–R22 four-layer P0 acceptance

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. Every one of 22 staging, production and original incident rows remains BLOCKED.

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

## Independent #780 P1 feature acceptance

| P1 | Source | Staging | Production | Grounded consequence |
|---|---|---|---|---|
| P1-INV | NOT_TESTED | BLOCKED | BLOCKED | No complete owner-source feature acceptance demonstrated |
| P1-DIFF | NOT_TESTED | BLOCKED | BLOCKED | No complete owner-source feature acceptance demonstrated |
| P1-SANDBOX | FAIL | BLOCKED | BLOCKED | #800 git fsmonitor PathPolicy escape reproduced |
| P1-LOOP | NOT_TESTED | BLOCKED | BLOCKED | No complete owner-source feature acceptance demonstrated |
| P1-CKPT | NOT_TESTED | BLOCKED | BLOCKED | No complete owner-source feature acceptance demonstrated |

One of five P1 features, P1-SANDBOX, has a true source FAIL, and the other four remain NOT_TESTED. All five staging/production BLOCKED. #793 and #798 docs successes, #795 and #801 source QA successes, #797 source checkpoint success do not amount to delivered restricted OS sandbox.

## Non-negotiable physical release NO-GO

- Signed first-party protected broad HIGH CORE with bounded <=15minute ROOT; real owner-approved local UAC and actual token/process identity not accepted.
- #271 actual native protected EXE/DLL/ancestor ACL, #551 signed complete installer/rollback, #587 independent non-restorable monotonic CAS, #588 authenticated durable onecall and immutable final published receipt, #617 typed GUID-scoped elevated Hyper-V Running readback unverified.
- ReVoltVPN-Ubuntu-Lab untouched. Original P0 negative tests unchanged, no live Agent/VM/UAC/ACL, no main merge.

FINAL: Production NO-GO. #803 full CI green is not safe merge authority.
