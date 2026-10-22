# Nexowire #16 | Independent QA #774–#780

22 October 2026. Pinned main: 754cc4364822be5fda528f54042fb22a84f19924. This is a QA-only branch, not a main release. Issue #780 is a P1 product epic, not a PR or a P0 regression.

## Exact HEAD and full workflow

| PR | Head SHA | Base SHA | CI run | Overall | Limitation |
|---|---|---|---|---|---|
| #774 | 5e432c26072d | 00ad9a4f061a | 39806480924 | SUCCESS | test-only child of #768 external publication commit; quota UNKNOWN writer-stop/deletion release negative; 7/7 hosted checks success, not physical writer-stop evidence |
| #775 | 2184612804ed | 6967cc92ae85 | 39806640003 | SUCCESS | signed final Access CAS binds installed FileID/native witness time in source fixtures; real signed installed HIGH Broker still missing |
| #776 | a427e3d127d2 | 3247ed65133a | 39816348613 | FAILURE | NEW HEAD exact CI FAILURE: Node24 four source negatives (3 unchanged #762 final receipt tests cannot start without independent monotonic publication CAS; 1 cancel test expected CANCELLED but got MUTATION_UNKNOWN with transfer cancel-after-mutation provenance); browser-live Windows now SUCCESS. Historical prior head 7e360388 Windows Job fast-exit iteration4 FAIL retained separately. |
| #777 | c41e441a87f5 | 00ad9a4f061a | 39807272228 | FAILURE | source guard for unresolved Native publication resume; Node22/24 PASS, browser-live Windows Job fast-exit iteration8 FAIL; no physical end-to-end publisher |
| #778 | 540770c173a8 | 10d3fedc8993 | 39807830909 | SUCCESS | QA24 incremental DAG source for 175 open at snapshot, 173 identified, 2 unresolved; not a complete live dependency graph or approval to merge |
| #779 | 8487b5be3973 | cd01c7e80a9d | 39808685776 | FAILURE | mandatory 7 true P0 red plus Windows ProcessManager restart NW_DURABLE_READY timeout; Node24 fails mandatory gate and Node22 cancelled |

Full CI at exact HEAD: 3 SUCCESS (#774/#775/#778), 3 FAILURE (#776/#777/#779). #774 initial query showed no runs, but a same-SHA check-runs lookup returned seven green hosted jobs and CI 39806480924 SUCCESS. #780 has no PR HEAD or CI.

## Full CI failure provenance

- #776 **CURRENT HEAD a427e3d** full CI **39816348613 FAILURE**: Node24 job 119955780908 has 4 source negatives. Three unchanged #762 receipt/foreign immutable SHA/forged ACK cases cannot start without independent monotonic publication CAS. A fourth existing owner-worker cancellation test expected CANCELLED but received MUTATION_UNKNOWN with confirmed chunk / TRANSFER_CANCEL_AFTER_MUTATION. The current Windows browser-live job 119955781543 is SUCCESS. OLD HEAD 7e3603 full CI 39809339319 FAILED with Node24 3 negatives and Windows Job fast-exit iteration4; retained as historical, not current.
- #777 run 39807272228: Node22/24 source tests PASS for blocking unresolved Native publication resume, yet browser-live Windows Job stdout-before-exited iteration8 fails; overall full CI FAILURE, no physical publication attestation.
- #779 run 39808685776: mandatory 7 P0 source contract failures preserved, covering signed actual HIGH CORE, signed ROOT <=15m, typed scoped elevated Hyper-V vs STANDARD, #587 restored old journal duplicate and #588 durable onecall API absent. Separate browser-live Windows durable ProcessManager reattach NW_DURABLE_READY timeout ~27.1s. Node24 required gates fail and Node22 cancelled. Not a green result despite first empty search.

## Positive source evidence only

- #774: external publication commit does not prove independently witnessed writer stop and deletion or release of tenant UNKNOWN memory. Full source CI green; no real final publisher.
- #775: signed final Access CAS grant source bound FileID/witness time CI green, not a running protected first-party HIGH Broker or physical effective ACL.
- #778: incremental QA24 DAG CI green but snapshot of 175 open PRs was missing two PR records; incomplete DAG cannot establish safe merge candidate set or production readiness.

## R01–R22 original P0 acceptance

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. All 22 staging, production and incident entries BLOCKED.

| R | Source | Staging | Production | Incident |
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

## Independent P1 issue #780 checklist

Read QA_P1_FEATURE_ACCEPTANCE_ISSUE780_20261022.md. Feature inventory, preview/approve/reject/apply/rollback with Git SHA and side-effect truth, OS-backed task sandbox, bounded plan→tool→observe→test→stop loop and encrypted source/owner-epoch scoped checkpoint are separate P1 feature acceptance items. All source NOT_TESTED, staging/production BLOCKED. This task did not independently inventory owner implementation, so no unsupported feature-present or feature-absent assertion is made.

## Non-negotiable physical production NO-GO

- #271: actual inherited low-trust Modify ACL on historical installed privileged code; signed EXE/import/updater ancestry and OS PID token not physically verified.
- #551: first-party signed installed HIGH Broker, one-time actual local UAC and signed complete previous Agent rollback missing.
- #587: no deployed external non-co-restorable monotonic owner CAS against co-restored old journal; duplicate requestId remains a mandatory red.
- #588: no advertised durable onecall transfer API on main, physical signed publisher SHA/requestId/epoch receipt, independently verified writer-stop/deletion and final commit proof.
- #617: hyperv.vm.start source privilege still STANDARD, not signed typed GUID-scoped elevated Broker authority with trusted VM Running readback. ReVoltVPN-Ubuntu-Lab untouched.

Only QA docs, independent evidence test and non-skipped CI invocation changed; no original mandatory negative acceptance modification, no live VM/Agent/UAC/ACL/Cloudflare/DB changes or production merge.

FINAL: P0 PRODUCTION NO-GO. P1 FEATURE ACCEPTANCE NOT_TESTED.
