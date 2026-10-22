# Nexowire #16 | Exact #779 and #790 failed-step CI audit

22 October 2026. Pinned main 754cc4364822be5fda528f54042fb22a84f19924. Only independent QA documents and provenance tests; no main merge or physical mutation.

## Exact HEAD and full CI

| PR | HEAD | BASE | Full run | Conclusion |
|---|---|---|---|---|
| #779 | 8487b5be39737c10f0edfaf6da55bc37d5bad8fe | cd01c7e80a9d1eac8309b6fea4fa21a82f246a19 | [#39808685776](https://github.com/Naveax/Nexowire/actions/runs/39808685776) | FAILURE |
| #790 | bc9eba3a57ce9dba9ac141f8746c511bc82914d9 | 8487b5be39737c10f0edfaf6da55bc37d5bad8fe | [#39818835181](https://github.com/Naveax/Nexowire/actions/runs/39818835181) | FAILURE |

An empty commit-run query never proved the absence of a run. The direct same-SHA GitHub Actions runs above are both FAILURE.

## Every failed or cancelled hosted job, categorized

| PR | Job ID | Job | Failed step | Outcome | Category |
|---|---|---|---|---|---|
| #779 | 119928712863 | test (24) | Run npm run check | FAILURE | MANDATORY_P0_GATES_IN_GENERAL_SUITE |
| #779 | 119928712888 | qa-independent-negative-acceptance | Verify unresolved P0 rollback and one-call transfer acceptance | FAILURE | MANDATORY_P0_NEGATIVE_ACCEPTANCE |
| #779 | 119928712954 | browser-live | Run node --test --import tsx test/durable-process.test.ts | FAILURE | INDEPENDENT_WINDOWS_DURABLE_REATTACH_FAILURE |
| #779 | 119928713216 | test (22) | Run npm run check | CANCELLED | CANCELLED_NOT_PASS_OR_SEPARATE_ASSERTION |
| #790 | 119964334776 | test (24) | Run npm run check | FAILURE | MANDATORY_P0_GATES_IN_GENERAL_SUITE |
| #790 | 119964334955 | qa-independent-negative-acceptance | Verify unresolved P0 rollback and one-call transfer acceptance | FAILURE | MANDATORY_P0_NEGATIVE_ACCEPTANCE |
| #790 | 119964334340 | browser-live | Run node --test --import tsx test/durable-process.test.ts | FAILURE | INDEPENDENT_WINDOWS_DURABLE_REATTACH_FAILURE |
| #790 | 119964334853 | test (22) | Run npm run check | CANCELLED | CANCELLED_NOT_PASS_OR_SEPARATE_ASSERTION |

Linux native, WSL2, macOS Agent lifecycle and security-operational hosted siblings SUCCESS on both runs. The full CI is still FAILED. Node22 was CANCELLED during check and cannot be called green.

## Seven mandatory P0 source acceptance failures retained

The dedicated qa-independent-negative-acceptance job on EACH run has 17 tests: 10 PASS, 7 FAIL, 0 SKIP. Node24 general npm run check fails the SAME seven source assertions. No separately demonstrated TypeScript syntax failure was found in these failed job logs. Never skip, xfail, invert, suppress or redesign these original negative tests simply for green.

| Contract | Result | Required actual acceptance |
|---|---|---|
| ROOT_ISSUED_MAX_900S | FAIL | Authenticated signed ROOT issue-time maximum 15min, not arbitrary future expiration |
| REAL_INSTALLED_HIGH_CORE_EXECUTOR | FAIL | Broad signed protected Windows HIGH CORE executor, not SAFE alias |
| EXPLICIT_SIGNED_CORE_BROKER_ENDPOINT | FAIL | Authenticated owner/session/current epoch elevated Broker endpoint |
| HYPERV_VM_START_TYPED_ELEVATED | FAIL | hyperv.vm.start must not be STANDARD |
| HYPERV_VM_GUID_SCOPED_BROKER | FAIL | Current scoped signed VM GUID permit and independent running readback |
| ROLLBACK_INDEPENDENT_AUTHORITY_587 | FAIL | Old restored J+A journal must not re-admit completed requestId |
| DURABLE_ONECALL_PUBLICATION_588 | FAIL | Public authenticated durable start/status/cancel and independent final publisher proof |

Root signed 900 second issue-time lease, broad truly signed installed Windows HIGH CORE executor, registered authorized Broker endpoint, typed elevated GUID-scoped Hyper-V vm.start, independent old-journal antirollback #587 and authenticated durable onecall plus actual external final publisher #588 remain NO-GO.

## Separate inherited Windows durable-process failure

Both exact HEAD browser-live jobs fail the same test/durable-process.test.ts assertion: stdin/stdout must reattach across ProcessManager restart, but NW_DURABLE_READY output is not seen.
- #779 browser-live job 119928712954 failed after ~27.108s.
- #790 browser-live job 119964334340 failed after ~26.573s.
This is an independently required Windows runtime/host contract regression. It is NOT one of the seven intentionally red P0 acceptance assertions. Its root cause is not proved merely by the timeout; do not relabel it a harmless flaky host.

## Original R01–R22 P0 acceptance

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. All 22 staging, production, original incident BLOCKED.

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

## Separate #780 P1 product epic acceptance

Issue #780 is P1 feature scope, NOT a new P0 regression or pull request. Feature source inventory not independently inspected in this turn; every item is NOT_TESTED. Review QA_P1_FEATURE_ACCEPTANCE_ISSUE780_20261022.md for detailed adversarial source/staging/production criteria.

| Feature | Source | Staging | Production |
|---|---|---|---|
| P1-INV Feature inventory and code ownership | NOT_TESTED | BLOCKED | BLOCKED |
| P1-DIFF Git scoped preview approve apply and verified rollback | NOT_TESTED | BLOCKED | BLOCKED |
| P1-SANDBOX Real OS task isolation not pathname policy | NOT_TESTED | BLOCKED | BLOCKED |
| P1-LOOP Bounded deterministic task worker plan tool observe test stop | NOT_TESTED | BLOCKED | BLOCKED |
| P1-CKPT Durable encrypted scoped checkpoint and safe resume | NOT_TESTED | BLOCKED | BLOCKED |

## Genuine physical NO-GO

#271 protected installed effective ACL, #551 first-party signed actual HIGH Broker/local UAC/full Agent rollback, #587 independently non-restorable atomic external CAS, #588 published SHA/requestId/current epoch real final receipt and onecall, and #617 typed elevated exact Hyper-V GUID Running witness have no accepted production evidence. ReVoltVPN-Ubuntu-Lab untouched.

Original negative security test files unchanged; independent QA evidence tests do not override full CI or actual physical authority. No live VM, UAC, Agent, ACL, DB or main merge.

FINAL: #779 FAILURE; #790 FAILURE; R01–R22 P0 source mixed, all physical blocked; #780 P1 feature source NOT_TESTED.
