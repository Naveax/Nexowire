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


---

## NEXT4 update | 23 October 2026 | exact-current HEAD and historical negative provenance

This section is a **time-scoped QA evidence refresh**, not a rewrite of the 22 October #791–#803 historical snapshot. #809 is a QA-only DRAFT stacked on #802, not on main. Coordinator reported **245 OPEN PRs** and newest #847 from date-partitioned search; that cardinality is *coordinator-provided, not independently re-counted by QA16*. The #811 PR reports main/base SHA \`754cc4364822be5fda528f54042fb22a84f19924\`; no main merge has been performed in this work.

### HEAD / CI refresh with non-transferable evidence

| PR | Exact current HEAD at review | Exact full CI run | Verified CI outcome | What was actually shown |
|---|---|---|---|---|
| #826 | \`ba21955cedc7be43fe57c5b2fe4c8e2c4c656966\` | [39938851608](https://github.com/Naveax/Nexowire/actions/runs/39938851608) | **FAILURE** | Node24 \`npm run check\` has **18 existing positive tests failing** after \`RECONCILE_REQUIRED\` pre-dispatch denial, while targeted direct \`task.graph.run\` denial passes. Windows Job separate-pipes positive also fails (\`WINJOB_STDOUT\` absent). Six other job outcomes: Linux, WSL2, macOS, security SUCCESS, Node22 CANCELLED; Node24 and browser-live FAIL. Missing off-host atomic CAS remains **BLOCKED**. |
| #847 | \`79fdecf348b526c1e876f434d6f0292769b2bc17\` | [39914505805](https://github.com/Naveax/Nexowire/actions/runs/39914505805) | **FAILURE** | On **old** #826 ancestry \`5e307dd48657512ed0e5d5b2908e7d2cd93ec6b5\`, original \`test/connection-826-direct-graph-unknown-deny.RED.test.ts\` shows **2** inert marker processes versus expected **0**. Genuine old-base direct-dispatch source-negative RED; it is **not** evidence that the same test fails on current #826 HEAD. Cross-replay of the **exact original blob** against current #826 is **NOT_VERIFIED**. |
| #811 | \`daa166e42f94fa1529b48c293a51c58b1c2384e7\` | [39939395440](https://github.com/Naveax/Nexowire/actions/runs/39939395440) | **FAILURE** | Node22 and Node24 SUCCESS, including existing Git fsmonitor/worktree/metadata/filter negatives; copied unchanged #845 commit-graph symlink negative **PASS** on Node24, as a **source test only**. Windows browser-live FAIL on fast-exit stdout captured after \`exited\`, iteration **0**. No physical OS sandbox, restricted token, Broker, native writer CAS, or Windows Git TEMP positive is proven. |
| #845 | \`6b16de921ce059f28f5e2e9254ff9de764457bef\` | [39868037273](https://github.com/Naveax/Nexowire/actions/runs/39868037273) | **FAILURE** | Independently authored nested \`.git/objects/info/commit-graph\` FILE symlink negative fails on historical #811 base \`600a0286557d360681be7bd7b86da95ba57f1980\` (missing expected pre-Git rejection). Separate hosted Windows PowerShell structured-control timeout; original healthy Git-for-Windows fixture compatibility is **not** established on latest #811. Historical RED remains preserved; source fix is evidenced by #811's current Node24 copied test, not a physical Windows acceptance. |
| #829 | \`5715402142968498ce6d53014888e1c39f6e2ac9\` | [39863445519](https://github.com/Naveax/Nexowire/actions/runs/39863445519); [39863445634](https://github.com/Naveax/Nexowire/actions/runs/39863445634) | **SUCCESS 7/7** full CI; **SUCCESS** dedicated Windows QA | Durable NWJOB5 early stdout/stderr listener-before-start **source/hosted Windows-test success**. Does **not** establish signed HIGH Broker, low-token/AppContainer confinement, no PROCESS_DUP_HANDLE, or original physical incident restoration. |
| #809 | \`a43933a42391cccbe426fa7a02382f08764f572f\` (prior to this docs-only update) | [39843088157](https://github.com/Naveax/Nexowire/actions/runs/39843088157) | **FAILURE** | Stacked QA run inherited mandatory P0 negative failure, Node22 \`npm check\`, and Windows durable timeout; current docs update is not a P0 source repair. Its eventual new-SHA CI, if automatically launched, must be evaluated separately. |

**Earlier exact-SHA results remain historical, never overwrite current:** #826 \`aabc75fd539dfb1b5db42d958ba344d12bad4f3c\` run \`39914532851\` FAILURE with five new denial negatives PASS and 18 legacy positives FAIL; #811 \`f7a8fae628a84b2580ec2f5ccf7195aea28595cb\` run \`39913730567\` SUCCESS 7/7. The old 7/7 #811 green is **not** its current full-CI status. #847 and #845 old-base RED are retained with their specific parent SHA.

### Negative interpretation rules

- **SOURCE_NEGATIVE_RED_REPRODUCED_OLD_BASE:** #847's 2 versus 0 inert subprocesses after original UNKNOWN on old #826; #845's outside-root nested commit-graph FILE symlink accepted on old #811; #800 original fsmonitor escape. None can be quietly marked a present-head failure without exact test replay.
- **CURRENT_SOURCE_GUARD_PASS_BUT_FULL_CI_RED:** #826 current direct \`task.graph.run\` pre-dispatch denial and preservation of original UNKNOWN in focused negatives, yet 18 unchanged positive tests fail. Do not reinterpret blanket fail-close as full functional success and do not silence or rewrite positives.
- **CURRENT_SOURCE_NEGATIVE_PASS_FULL_CI_RED_UNRELATED:** #811 current Node22/24 Git attack tests, including copied #845, pass; the exact overall run fails its independent Windows Job regression. This is a narrow source repair, **not** a production sandbox certification.
- **WINDOWS_HOSTED_POSITIVE_GREEN_SOURCE_ONLY:** #829 source and dedicated Windows CI are green. No claim of measured same-user handle isolation, token integrity, signed native HIGH, protected ACL, or staged installed Broker follows.
- **CROSS_REPLAY_NOT_VERIFIED:** Original #847 exact test against current #826; #845 healthy Git-for-Windows TEMP control against current #811. These remain unresolved regardless of another PR's passing test or green CI.
- **PHYSICAL_REQUIRED_OFFHOST_BLOCKED:** External non-restorable reserve/commit-for-dispatch serialized against revoke-start; signed installed HIGH Broker/import tree; bounded ROOT authorization; immutable source/worktree/owner epoch; original native effect receipt and independent staging/production readback. Pure callbacks, SQLite/JSON, mocked CAS, static snapshots, and user-interface labels cannot replace these.

### R01–R22, four independent layers (unchanged baseline)

**No negative cases were removed, skipped, weakened, reclassified as fixed, or altered by this QA update.** Historical source statuses remain **6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED**. **All 22 staging, all 22 production, and all 22 original-incident rows remain BLOCKED.** The original table above and structured \`docs/qa/cross-project-final-acceptance.json\` are preserved verbatim.

| Acceptance slice | QA16 decision at this refresh | Release implication |
|---|---|---|
| R02 durable journal; R20 atomic CAS | Historical source **FAIL**. #826 direct-admission denial succeeds narrowly; original UNKNOWN clone cross-run not independently replayed; external non-restorable CAS not installed. | Staging/production/original incident **BLOCKED** |
| R03 Hub/Agent reconciliation; R06 reconnect | R03 **BLOCKED**, R06 historical source **PASS** unchanged. #847 source-negative RED belongs to old #826; reconnect/source receipt not a post-effect native witness. | All physical **BLOCKED** |
| R05 constrained filesystem; R10 checkpoint | R05 **BLOCKED**, R10 historical source **PASS** unchanged. #811 Git no-follow tests narrow to isolated source; no protected Windows root-relative native handle witness. | All physical **BLOCKED** |
| R07 process child ownership | Historical source **FAIL** preserved. #829 dedicated hosted durable output PASS on owned branch, whereas #826/#811 current unrelated Windows Job tests are RED. | All physical **BLOCKED** |
| R04 signed ROOT/CORE Broker; R15 artifact continuity; R22 release gates | Historical source **FAIL** unchanged, even if individual branch-level tests are green. No signed installed high token, real approval/expiry readback, or release proof. | All physical **BLOCKED** |
| Other R01–R22 | Original source rows and negative evidence are unmodified; no mass promotion from independent child PR results. | All physical **BLOCKED** |

### P1 #780 source / staging / production partition

- **P1-SANDBOX:** historical #800 / #845 source-negative **FAIL on their own old bases**. Current #811 Git executor targeted source negatives **PASS** on Linux CI; source-level Git repair **observed only on #811**, not yet integrated/accepted globally. Full #811 CI is RED (Windows Job), and physical restricted worker/AppContainer/handle isolation still **BLOCKED**. Preserve aggregate historical P1-SANDBOX **FAIL** until a separate exact-current comprehensive review changes it.
- **P1-INV, P1-DIFF, P1-LOOP, P1-CKPT:** original aggregate source **NOT_TESTED** remains, regardless of independent scoped green features in other PRs. Staging and production **BLOCKED** for all five P1 areas.
- **R01–R22 staging / production / original physical incident:** **BLOCKED**, independent of source PASS / source-negative RED or fixed-on-another-head. No source result is a deployed protected OS/Broker/CAS/ACL proof.

**Decision: P0 NO-GO, P1 production NO-GO, merge queue EMPTY.** No merge, workflow rerun for an unchanged SHA, deployment, live Agent 1.0.5, D1, UAC, ACL, user-file, VM, or ReVoltVPN-Ubuntu-Lab change was made during this docs-only QA16 review.
