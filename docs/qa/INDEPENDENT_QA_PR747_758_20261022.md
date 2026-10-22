# Nexowire #16 | Independent QA #747-#758 exact-head acceptance

22 October 2026. Pinned main 754cc4364822be5fda528f54042fb22a84f19924. QA-only child branch of #758, not main.

## Current exact HEAD and CI

12 PRs checked. Six full CI SUCCESS, four FAILURE, two exact-head workflows NOT VERIFIED (#747/#749). No workflow is not green. Separate QA26 (#753) and native Windows QA03 (#756) successes do not add extra full CI successes.

| PR | HEAD | Base | Run | Result | Scope |
|---|---|---|---|---|---|
| #747 | 13acf85b063c | df239ce88f4b | none verified | NOT_VERIFIED | No workflow returned at exact HEAD; late signed permit final authority CAS negative must not be marked green |
| #748 | 9ffe6accaa45 | aa16d3e0fc26 | 39735987704 | PASS | OAuth epoch atomic refresh source CI SUCCESS, not native Windows CORE token nor deployed D1 |
| #749 | 98870fb43baf | 8b17168e6102 | none verified | NOT_VERIFIED | No workflow returned at exact HEAD; source unknown after late permit and revoke cannot be claimed verified |
| #750 | 90e4819dceba | c68c561dae9a | 39735615243 | FAIL | Node24 private picker refuses forged tracked PID test FAIL because PrivateDesktopError requires Windows on Linux; separate from mandatory P0 gate |
| #751 | 2530ccaf6baa | b93ee12a7737 | 39735623362 | FAIL | Hosted Windows Job fast-exit stdout not captured before exited iteration5; external durable owner witness source not full CI green |
| #752 | 95bea58abf5b | b93ee12a7737 | 39735641942 | PASS | Reconnection orphan native intent UNKNOWN across double reconnect source CI SUCCESS, no automatic replay; final publication receipt physical unknown |
| #753 | 72ff16a23881 | 7bc16b4cd101 | 39735984623 | PASS | Strict JSON v1 input version type confusion negative source CI and QA26 39735984797 SUCCESS, no installed high-token Broker signer proof |
| #754 | 3a5bf392109d | 09c3dcaf2310 | 39736052869 | FAIL | Native independently authenticated final publication SHA/requestId/owner epoch source change, full CI Windows Job fast-exit iteration6 FAIL; not proof of physical durable final receipt |
| #755 | 631664368475 | aec8a331ab6e | 39736251296 | PASS | Signed CORE permit import DAG SYSTEM DPAPI and rollback source CI SUCCESS, no installed verified first-party signed Broker |
| #756 | d4ed32f72701 | 7bc16b4cd101 | 39736305461 | PASS | Dedicated Windows PID FILETIME/AccessCheck QA39736305459 and full CI SUCCESS; physical installed protected Broker effective ACL and high token not attested |
| #757 | 93acbb7a4e83 | 5c2b39530937 | 39736445337 | PASS | Late signed permit read-only double CAS verify source success, not atomic external dispatch grant vs revoke-start across Hubs |
| #758 | 74917540d897 | c9e0e93a9b8a | 39736944182 | FAIL | MANDATORY seven P0 native source acceptance RED plus independent Windows durable READY timeout; generic Node24 fails required source negatives, Node22 cancelled |

## Real CI failures separated from mandatory P0 production gates

- #750 exact run 39735615243 FAIL: private picker forged tracked PID rejection expected but Linux runner raises PrivateDesktopError requires Windows. Host/platform test contract error, not physical UAC proof.
- #751 run 39735623362 FAIL: Windows Job fast-exit exited before stdout captured, iteration 5.
- #754 run 39736052869 FAIL: Windows Job fast-exit exited before stdout captured, iteration 6. New final publisher source receipt cannot be called independently authenticated deployed physical final readback.
- #758 run 39736944182 FAIL: dedicated required P0 job 119685142704 has 10 PASS, 7 real missing product acceptance assertions FAIL, 0 SKIP. Missing real signed broad Windows HIGH CORE executor, signed ROOT exact <=900s, separate authenticated elevated Broker endpoint, Hyper-V typed VM GUID signed elevated permit rather than STANDARD, #587 rollback-resistant independent witness, and #588 advertised authenticated durable onecall transfer API. Keep every red test.
- #758 unrelated Windows browser-live job 119685142763 also FAIL on durable ProcessManager restart NW_DURABLE_READY output not observed after about 26.7 seconds. Distinct from intended seven P0 red. Node24 general check FAIL includes required security gates, Node22 CANCELLED.

## Successfully tested source is not successfully deployed physical CORE

- #748 OAuth browser-bound refresh source CI SUCCESS; OAuth credential is not native Windows elevated authority.
- #752 orphan UNKNOWN after double reconnect source CI SUCCESS; never auto-replay a possible native write.
- #753 strict JSON v1 negative source main CI and dedicated QA26 both SUCCESS; no signed installed Broker witness.
- #755 signed CORE import DAG source SUCCESS, #756 TEMP OS ACL/PID FILETIME main and dedicated QA03 SUCCESS; no independent high-integrity installed protected EXE, imports, updaters or parent ACL physical acceptance.
- #757 late permit double CAS read-only source CI SUCCESS; NOT atomic external final dispatch grant ordered against revoke-start across two Hubs. #747/#749 have no verified exact-head workflow.

## R01-R22 four-level matrix

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. Staging, production and original incident all 22/22 BLOCKED.

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

## Mandatory physical release NO-GO

- Real CORE requires a running first-party signed Windows protected HIGH-integrity Broker for broad persistent owner-revocable admin shell, once genuine local UAC bootstrap, current signed owner/device/epoch, and atomic external grant. ROOT <=15m from authenticated issue time. Not a SAFE alias.
- Hyper-V vm.start is wrongly STANDARD on source main; only owner-GUID scoped elevated Broker action and independent exact VM Running readback acceptable. ReVoltVPN-Ubuntu-Lab UNTOUCHED.
- #271 legacy installed privileged code inherited Authenticated Users Modify. Signed EXE imported DLL parent updater effective ACL and token PID+FILETIME physical proof absent.
- #551 verified Nexowire first-party signed native complete bootstrap + signed old Agent rollback and local UAC physical approval absent.
- #587 local old journal/authority backup rollback re-admits completed requestId; no external non-co-restorable independently administered CAS authority and final revoke/dispatch atomic witness.
- #588 onecall transfer start/status/cancel missing from main. #754 source final publisher changes are not completed independent immutable SHA/requestId/current epoch/provider readback, no physical 1GiB transfer completion.

Only QA docs, independent QA evidence test and its CI invocation are changed. Existing four P0 negative source suites unchanged and non-skipped. No Agent, VM, UAC, ACL, Broker, user file, Cloudflare/DB or main mutation. Historical QA ledger unchanged.

FINAL PRODUCTION ACCEPTANCE: NO-GO.
