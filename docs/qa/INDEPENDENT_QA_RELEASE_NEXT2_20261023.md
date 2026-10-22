# Nexowire #16 | 23 October 2026 NEXT2 independent release QA

Pinned main 754cc4364822be5fda528f54042fb22a84f19924. Scope QA docs and independent evidence ONLY; no live Agent, Broker, VM, UAC, ACL, D1, billing, files or production merge.

## Current exact HEAD and hosted CI

| PR | Exact HEAD | Base | Full run | Status | Interpretation |
|---|---|---|---|---|---|
| #837 | 1d2a45580340 | a43933a42391 | 39864371572 | FAILURE | Not a seven-case test defect. Actual current pinned source lacks scoped elevation, external rollback CAS, public durable onecall. Intentional mandatory negatives are true P0 release NO-GO; separate Windows ProcessManager reattach is runtime regression. |
| #821 | ef87410cc792 | 600a0286557d | 39862537837 | FAILURE | Genuine deterministic source P1 sandbox escape: repository-controlled filter.clean executed by workspace.snapshot git status and wrote outside allowed PathPolicy/task root. Not test fixture failure. Same branch #811 candidate, not physical production. |
| #814 | daec5dbd6da1 | 600a0286557d | 39865936576 | FAILURE | Three true source negative failures on real workspace.snapshot/detect, not fixture-only; unrelated hosted Windows Job stdout-before-exited iteration7. Five other Git hostile checks PASS but incomplete containment. |
| #826 | 5e307dd48657 | 3dc5f12fdbf7 | 39866105972 | FAILURE | Source Node22 4 existing positive task_graph/private runbook tests fail because blanket external-CAS-deny refuses callbacks; intentional compatibility loss, not missing negative detection or safe production dispatch. Node24 CANCELLED; Windows browser-live SUCCESS. |
| #829 | 571540214296 | 7bc16b4cd101 | 39863445519 | SUCCESS | Full exact-head 7 jobs CI success plus dedicated Windows durable NWJOB5 source QA success. Real installed Agent1.0.5/privileged Broker not tested. This branch is not a merge into #837 so its success does not fix #837 Windows durable regression in that source tree. |

## #837 seven P0 RED: correct acceptance failures, not mistaken test expectations

- Node24 generic npm run check FAILED with seven mandatory original P0 cases; independent qa-independent-negative-acceptance job 120122734718 runs 17 tests, **10 PASS / 7 FAIL / 0 SKIP**. No separate TypeScript parse failure in reviewed jobs.
- ROOT lease accepts >900 seconds based on arbitrary future expiry; signed first-party protected HIGH broad CORE executor remains classified standard, explicit signed owner/session/epoch Broker endpoint absent.
- hyperv.vm.start incorrectly STANDARD and no signed typed exact VM GUID scoped permit. Real local UAC approval and independent VM Running readback absent.
- #587 restored old journal accepts completed requestId without a physically separate non-restorable monotonic grant; #588 authenticated public durable transfer start/status/cancel missing.
- These are intentionally mandatory RED negative tests **which correctly reproduce P0 production contract gaps**. Never delete, xfail, invert or weaken the assertions. Yet this source finding alone is not signed native Windows physical evidence.
- Separate Windows browser-live job 120122734889 FAILED durable ProcessManager restart waiting approximately 26.337 seconds for NW_DURABLE_READY. A real independent runtime/host regression, not a seventh P0 test.

## #821 #814 hostile Git: source sandbox negatives reproduced

- #821 exact Node24 job 120116564545, test/p50-780-git-clean-filter-external-command-negative.test.ts: repository-controlled Git filter.clean runs while real workspace.snapshot executes read-only status, writing beyond approved task root. Genuine unsafe source behavior, not fixture failure. Browser-live Windows green on same branch does not refute Node24 real witness.
- #814 exact Node24 job 120128010532 has THREE genuine fail-closed source negatives: nested refs/heads link, loose object directory link, and packed Git object directory link outside task root, real workspace.snapshot/detect failed to reject. Other five Git hostile cases green. Independently Windows Job stdout-before-exited iteration7 fails browser-live; Node22 cancelled.
- Prior #800 core.fsmonitor attack is a separate source P1 sandbox negative. Combined source P1-SANDBOX status **FAIL**. Sandbox is an actual restricted OS process, not just Git flags/path checks. Fix owner #31, PathPolicy #05; QA never modifies executor.

## #826 deliberate blanket native runbook fail-close

- Latest exact #826 HEAD 5e307dd48657512ed0e5d5b2908e7d2cd93ec6b5, CI 39866105972 FAILURE at evidence snapshot. Actual PR says executeDurableRunbook denies all task_graph callbacks at dispatch when external atomic commitIfCurrent provider absent, preserving original MUTATION_STATE_UNKNOWN -> RECONCILE_REQUIRED, runbook interrupted, assertions read-only allowed.
- Blanket deny is an explicit **availability/compatibility regression**, not a proven bypass or external CAS implementation. Legacy successful task_graph positives may turn RED; never suppress those failures or fabricate a local always-true CAS. No possible Native effect replay.
- P0 #587 and trusted original immutable logicalMutationId/source SHA/current owner epoch plus externally atomic revoke-start CAS are still missing, and no signed protected HIGH executor can be accepted.

**#826 final CI correction:** Node22 120128575331 fails four existing positive tests: headless override invocation count 0 vs 1, nested private task graph denied, durable dependencies expected completion denied, and retry_unknown raises RunbookAdmissionRequiredError RECONCILE_REQUIRED. This is a deliberate fail-closed availability regression, not a false security finding; external CAS still absent. Node24 cancelled, browser-live green. Do not edit original tests or simulate external authority.

## #829 two independent source CI successes

- Full seven-job CI 39863445519 SUCCESS and specialized Windows durable NWJOB5 QA 39863445634 SUCCESS at exact HEAD 5715402142968498ce6d53014888e1c39f6e2ac9.
- Source-only listener-before-resume correction in process-worker.ts is useful evidence for stdout/stderr race. Yet it is a different parent/tree than #837. No identical merged integration HEAD+CI, installed Agent 1.0.5 or physically signed Broker evidence; cannot claim #837 Windows reattach or actual physical production repaired.

## Original R01-R22 P0 matrix

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. ALL 22 staging, production, original incident BLOCKED.

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

## Independent #780 P1 feature matrix

| Feature | Source | Staging | Production |
|---|---|---|---|
| P1-INV | NOT_TESTED | BLOCKED | BLOCKED |
| P1-DIFF | NOT_TESTED | BLOCKED | BLOCKED |
| P1-SANDBOX | FAIL | BLOCKED | BLOCKED |
| P1-LOOP | NOT_TESTED | BLOCKED | BLOCKED |
| P1-CKPT | NOT_TESTED | BLOCKED | BLOCKED |

P1-SANDBOX source FAIL now grounded in core.fsmonitor (#800), filter.clean (#821), and three nested Git directory/pack links (#814). Other four features remain NOT_TESTED, P1 staging and production remain BLOCKED.

**FINAL: P0 production NO-GO.** R01–R22 native physical acceptance unchanged: installed first-party signed real broad HIGH CORE and ROOT 900s, typed elevated exact Hyper-V VM GUID, #271 protected ancestor/importer ACL, #551 actual local UAC/complete signed bootstrap rollback, #587 independent non-restorable external CAS, #588 signed independent final publisher durable onecall and actual VM Running readback. ReVoltVPN-Ubuntu-Lab untouched.
