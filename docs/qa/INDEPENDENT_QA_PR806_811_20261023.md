# Nexowire #16 | R01–R22 and P1 physical acceptance, exact HEAD audit

**23 October 2026.** Main pinned 754cc4364822be5fda528f54042fb22a84f19924. QA-only child branch of DRAFT #809, not main. No live Agent 1.0.5, Broker, UAC, ACL, D1/billing, user files or VM changes. Original mandatory P0 RED tests unchanged.

## Five current exact HEADs: source, staging, production and original incident

| PR | Exact HEAD | Full GitHub CI | Source proof | Staging | Production | Original incident |
|---|---|---|---|---|---|---|
| #809 | a43933a42391 | [#39843088157](https://github.com/Naveax/Nexowire/actions/runs/39843088157) FAILURE | BLOCKED_7_MANDATORY_AND_WINDOWS_REGRESSION | BLOCKED | BLOCKED | BLOCKED |
| #811 | 600a0286557d | [#39854971347](https://github.com/Naveax/Nexowire/actions/runs/39854971347) SUCCESS | SOURCE_CANDIDATE_SUCCESS_NOT_INDEPENDENT_NEGATIVE_ACCEPTED | BLOCKED | BLOCKED | BLOCKED |
| #808 | b69e4ac5664b | [#39841919586](https://github.com/Naveax/Nexowire/actions/runs/39841919586) SUCCESS | SOURCE_CANDIDATE_SUCCESS_NOT_INDEPENDENT_NEGATIVE_ACCEPTED | BLOCKED | BLOCKED | BLOCKED |
| #807 | 1e84d87c98c9 | [#39841880930](https://github.com/Naveax/Nexowire/actions/runs/39841880930) FAILURE | NOT_FULL_CI_GREEN_SOURCE_ADAPTER_CANDIDATE | BLOCKED | BLOCKED | BLOCKED |
| #806 | 13a6fb38cddd | [#39841477982](https://github.com/Naveax/Nexowire/actions/runs/39841477982) FAILURE | ADVERSARIAL_SOURCE_TEST_FAILS_API_CONTRACT_EXPECTATION | BLOCKED | BLOCKED | BLOCKED |

**Important:** #811 and #808 have all-jobs full CI SUCCESS, but neither is a deployed signed native HIGH Broker, real ACL/OS sandbox, independent external CAS or safely mergeable main. #807 and #806 are full CI FAILURE; source code changes alone cannot override failed hosted jobs.

## Exact source failure classification, no greenwashing

- **#809 HEAD a43933a42391cccbe426fa7a02382f08764f572f, run 39843088157 FAILURE.** Required independent P0 negative job 120049092580 FAIL retains original seven source checks (real signed HIGH CORE/ROOT, typed Hyper-V, #587 old journal rollback, #588 durable onecall). Node22 job 120049092896 generic npm run check also fails same seven. Node24 120049092477 CANCELLED, not pass or independent failure diagnosis. Separately browser-live Windows durable ProcessManager stdin/stdout restart test 120049093038 fails to see NW_DURABLE_READY after 27.205 seconds. This is a separate runtime failure, not an intentionally RED P0 feature test.
- **#811 HEAD 600a0286557d360681be7bd7b86da95ba57f1980, run 39854971347 SUCCESS.** Source-only repair for Git metadata/root boundary and unsafe includes/hooks/fsmonitor in workspace.snapshot and workspace.detect. Previous real #800 Git fsmonitor escape test remains a known adversarial red and has NOT been independently cross-run unchanged against #811 by #16. Do not promote to an OS task sandbox or physical production acceptance.
- **#808 HEAD b69e4ac5664b279e7c9a854a1946db8b433097cf, run 39841919586 SUCCESS.** Source-only CORE UI owner epoch/final native CAS state correction. Unchanged independent #726 stale ownerEpoch/early green CORE EFFECTIVE red is not cross-run here; actual running signed Windows HIGH Broker/owner UAC still missing.
- **#807 HEAD 1e84d87c98c91b2d6e97a47de610ffe353d199df, run 39841880930 FAILURE.** Browser-live Windows Job stdout not drained before exited status at iteration 0 (job 120044773235). The source saveIfCurrent checkpoint admission adapter may fail closed locally, but off-host atomic revoke-versus-durable-save guarantee and actual physical writer-stop are not established. Original #708 cloned UNKNOWN/revoke-start negative remains real red.
- **#806 HEAD 13a6fb38cddde635c71ca0f023b763c8f68534c6, run 39841477982 FAILURE.** Node24 test 120043339572 uses old expected WRITER_FENCE_REQUIRED from hostile cloned UNKNOWN staging quota fixture; current API throws TRUSTED_DELETION_EVIDENCE_REQUIRED first. This proves test/API contract mismatch, NOT actual refunded CANCEL_PENDING, NOT physical double-charge prevention and NOT verified writer stop/deletion. Node22 cancelled. Never weaken hostile test solely for a green check.

## Independent red adversarial proof remains separate

| Original PR | Exact head | CI | Confirmed unsafe observation | Still needs cross-test on proposed fix |
|---|---|---|---|---|
| #800 | 6eb562cffd68 | 39823730640 FAILURE | Real workspace.snapshot executed untrusted Git core.fsmonitor outside taskRoot | #811 mitigates source risk but QA16 did not run unchanged negative against latest #811 in isolation |
| #726 | 50491525249b | 39823764746 FAILURE | Stale ownerEpoch renders CORE EFFECTIVE without physical signed HIGH/CAS | #808 source fix CI success is not proof original unchanged negative passes when independently cross-run |
| #708 | 36b443ef300d | 39824007092 FAILURE | Revoke-start before checkpoint save; cloned UNKNOWN borrowed external final CAS, missing expected rejection | #807 adapter candidate has Windows CI FAILURE, no deployed off-host atomic CAS / physical writer stop |

The correct release interpretation is neither all RED means broken release candidate nor source GREEN equals physical approval. Intentional P0 negatives reproduce missing trusted boundaries; Windows Job output races and Node staging API mismatch are different classes.

## Original R01–R22 four-level mandatory P0 matrix

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. ALL 22 staging, production and original incident BLOCKED.

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

## Separate P1 #780 feature acceptance

| P1 feature | Source | Staging | Production | Evidence |
|---|---|---|---|---|
| P1-INV | NOT_TESTED | BLOCKED | BLOCKED | No complete independent end-to-end acceptance |
| P1-DIFF | NOT_TESTED | BLOCKED | BLOCKED | No complete independent end-to-end acceptance |
| P1-SANDBOX | FAIL | BLOCKED | BLOCKED | Original #800 unsafe fsmonitor outside-root reproduced; #811 source fix CI green but original negative not independently re-run |
| P1-LOOP | NOT_TESTED | BLOCKED | BLOCKED | No complete independent end-to-end acceptance |
| P1-CKPT | NOT_TESTED | BLOCKED | BLOCKED | No complete independent end-to-end acceptance |

P1-SANDBOX source FAIL remains until exact independent #800 hostile negative is rerun unchanged against #811 and any stronger OS sandbox requirement is independently met. Green Git executor root/path repair is not proof of OS process isolation. Four other P1 categories remain NOT_TESTED. P1 features do not bypass signed HIGH/ROOT or the P0 gates.

## Hard physical release blockers

- #271 actual protected native executable/import/ancestor/update effective ACL. #551 genuine first-party signed installed broker with one-time real local UAC and fully signed previous Agent rollback.
- #587 independent non-co-restorable monotonic atomic CAS ownerEpoch/requestId across two Hubs, revoke-start and cloned UNKNOWN, not mock/local SQLite restored together.
- #588 authenticated final immutable publisher SHA/requestId/jobId/exact owner epoch, atomic writer-stop and trusted deletion/readback before refund, advertised durable transfer start/status/cancel, not synthetic acceptance.
- Real broad signed protected Windows HIGH CORE, signed ROOT 900-second issue-time bound and typed GUID-scoped elevated hyperv.vm.start, exact independent VM Running readback.
- No live Agent 1.0.5, protected UAC/Broker/ACL, Cloudflare D1/billing, user files or ReVoltVPN-Ubuntu-Lab touched. No CI rerun on unchanged source SHA. No main merge.

**Production P0: NO-GO. P1: one source sandbox FAIL, four NOT_TESTED; all staging and production BLOCKED.**
