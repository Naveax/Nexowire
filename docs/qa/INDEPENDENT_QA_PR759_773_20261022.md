# Nexowire #16 | Independent exact-head QA #759–#773

**Reviewed 22 October 2026.** Main remains 754cc4364822be5fda528f54042fb22a84f19924. Child PR is QA-only, parent #769, never main. Source successes do not prove physical high-token CORE.

## Live GitHub exact SHA status at snapshot

Full CI: 8 SUCCESS / 3 FAILURE / 2 IN_PROGRESS / 2 no exact-head workflow returned. Earlier 6/3/4/2 snapshot was before #765/#770 CI completion. In-progress and missing workflows are UNKNOWN, not green. #763 dedicated QA03 39803137184 SUCCESS but normal CI 39803136306 still in progress; these are separate results.

| PR | Exact HEAD | Base HEAD | Full CI | State | Source limitation |
|---|---|---|---|---|---|
| #759 | 28f6a1cf063e | 90e4819dceba | 39802773499 | PASS | Private picker Linux forged PID QA correction source green; no physical secure desktop |
| #760 | 1e41df6cfc60 | 9ffe6accaa45 | 39802818096 | IN_PROGRESS | OAuth epoch/refresh source CI in progress, browser issuer session cannot attest Windows HIGH token |
| #761 | a19b1e698273 | 98870fb43baf | 39802972334 | PASS | Two-Hub native final commit/revoke linearization tests green source, external authority deployment unknown |
| #762 | 9709bfe2250d | 3a5bf392109d | 39803019258 | PASS | External rollback and signed SHA/forged ACK negative QA source success only, no actual final writer immutable receipt |
| #763 | e67f8f4ce14a | d4ed32f72701 | 39803136306 | IN_PROGRESS | Dedicated QA03 39803137184 SUCCESS on strict JSON schema, full CI remains in progress; input parser not installed Broker attestation |
| #764 | 12137946976c | 13acf85b063c | 39803317749 | PASS | External reserve-to-commit CAS against revoke-start and lost readback source green, not independent installed CAS |
| #765 | df145abbc7b2 | 631664368475 | 39803342678 | PASS | Signed importer ACL closure SYSTEM DPAPI rollback source in-progress, no physical signed install [Later same exact-head full CI SUCCESS; source only.] |
| #766 | 4b2f9c194100 | 3a5bf392109d | 39803836141 | PASS | Final publish receipt vs unknown writer-stop and quota release source QA green, no authentic production publication |
| #767 | 6967cc92ae85 | 93acbb7a4e83 | 39803417079 | PASS | Require installed signed Broker and final CAS grant source negative test CI green; actual installed HIGH still missing |
| #768 | 00ad9a4f061a | 3a5bf392109d | no exact run | NOT_VERIFIED | No exact-head workflow returned for external monotonic final publication commit; no green claim |
| #769 | cd01c7e80a9d | 74917540d897 | 39803688568 | FAIL | Mandatory 7 P0 source negatives plus independent Windows NW_DURABLE_READY process reattach timeout; no test skip |
| #770 | 131d96cdab40 | 95bea58abf5b | 39804271245 | PASS | Cross-reconnect Native final receipt exact CI in progress, cannot infer authenticated physical postcondition [Later same exact-head full CI SUCCESS; source only.] |
| #771 | 84856d5474f1 | 0f7c6af824c2 | 39804391279 | FAIL | Real Node24 public CORE status provider/CAS missing negative RED; Windows native surrogate attestation test FAIL ~20s, independent separate |
| #772 | 10d3fedc8993 | b8606439a6a9 | 39804484972 | FAIL | QA DAG 160-PR partition full CI FAILURE browser-live Windows Job fast-exit stdout-before-exited iteration1; source DAG cannot claim latest open count verified |
| #773 | ade5526b69b0 | 28f6a1cf063e | no exact run | NOT_VERIFIED | No exact-head workflow returned for private desktop physical STOP correction; no live UIA/UAC |

## Verified negative and failure classes

- **#769 exact source P0 RED:** current exact HEAD cd01c7e80a9d1eac8309b6fea4fa21a82f246a19; CI 39803688568 **FAILURE**. Dedicated qa-independent-negative-acceptance job 119911125445 FAIL preserves seven real P0 source gaps. CORE broad signed installed Windows HIGH executor and registered endpoint, signed ROOT 15-minute issuance bound, typed elevated hyperv.vm.start exact VM GUID allowlist (currently STANDARD), #587 independent rollback preventing old journal accepting duplicate completed requestId, #588 public durable onecall start/status/cancel. Do not delete/skip/invert/expect-fail these tests.
- **#769 independent Windows Job:** browser-live job 119911125386 fails durable ProcessManager reattach after ~26.85 seconds with no /NW_DURABLE_READY/ output. This is a separate real Windows process/host contract defect, not an intentional feature missing.
- **#771 CI 39804391279 FAILURE:** Node24 public CORE status readout contract requires separate absent-provider, installed HIGH and external CAS dispatch explanations; source negative fails. Independently Windows browser-live signed surrogate native attestation test hangs/fails around 20 seconds, null != 0. Never claim synthetic signed Windows test surrogate means installed Broker authorization.
- **#772 CI 39804484972 FAILURE:** Windows Job fast-exit announces exited before stdout is captured (iteration 1) in browser-live. The 160-PR partitioned DAG QA source result does not turn this full run green.
- **#763:** separate exact QA03 Strict Windows JSON V1 and Native Trust workflow 39803137184 SUCCESS. Full CI 39803136306 remains IN_PROGRESS in this snapshot; no full-green promotion.
- **#768 and #773:** no exact HEAD workflow returned. This is NOT_VERIFIED, never a result claim.

## Positive source results, limits

- #759 private picker forged PID Linux fixture source CI green, not live private UAC.
- #761 two-Hub final atomic native grant vs revoke source CI green, #762 immutable SHA/forged ACK negatives source green, #764 reserve/commit CAS race source green, #767 signed installed Broker and final grant QA source green: **none demonstrates** actually provisioned non-co-restorable independent CAS plus running first-party signed HIGH Broker and native durable effect witness.
- #766 pending native final publication vs writer-stop and quota release source CI green; source receipt is not physical signed final publisher SHA/requestId completion or 1GiB durable verified two-device readback.
- #760 OAuth issuer refresh and #763 typed JSON full CI still IN_PROGRESS. #765 signed import/DPAPI and #770 reconnect receipt full CIs now SUCCESS on their exact HEADs, source only.

## R01–R22 four-layer acceptance

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. **All 22 staging, production, original incident BLOCKED.**

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

## Physical production NO-GO, mandatory evidence

- **CORE:** Genuine once local-UAC-approved, first-party signed, protected, running Windows HIGH integrity Broker that executes broad owner-revocable persistent shell. ROOT max 900 seconds measured from signed issue time, FULL standard token. Synthetic signed source receipts or UI EFFECTIVE do not qualify.
- **Typed Hyper-V:** hyperv.vm.start wrongly STANDARD on actual pinned main; permit must be signed and scoped to owner/current epoch/exact VM GUID through real privileged Broker. Independent trusted VM Running readback not available. ReVoltVPN-Ubuntu-Lab untouched.
- **#271 ACL:** last known installed legacy privileged tree and CLI have inherited Authenticated Users Modify, protected executable and complete imported DLL/updater ancestry immutable effective ACL and PID creation FILETIME not physically confirmed.
- **#551 installation:** actual Nexowire first-party signed installer, legitimate local UAC, complete Agent1.0.5 signed rollback and two-device canary not proven.
- **#587 external CAS:** restored joint local journal+authority can re-admit completed requestId. No independently operated non-co-restorable monotonic owner/grant-generation epoch authority with atomic reserve/commit-for-dispatch versus revoke-start deployed.
- **#588 publication:** durable public transfer start/status/cancel unadvertised on main, final authenticated native SHA/requestId/current owner/epoch receipt and external immutable publisher postcondition missing; possible effect and lost ACK stay MUTATION_UNKNOWN, no auto replay or quota release until safe stop witnessed.

## QA-only file boundary

- Edited only independent QA documents, one additional provenance test and non-skipped invocation in the existing QA CI suite. Do not touch existing required four negative source suites, their expectations or conditional logic.
- Historical evidence ledger and previously time-scoped CI remain unchanged; GitHub exact HEAD snapshots do not imply complete open-PR count. No live Agent, VM, UAC, ACL, signed install, database/Cloudflare, user data, or main merge.

**FINAL RELEASE ACCEPTANCE: PRODUCTION NO-GO**
