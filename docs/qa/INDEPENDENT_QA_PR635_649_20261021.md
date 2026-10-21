# Nexowire #16 | 21 Oct 2026 independent PR #635-#649 QA

**Source main:** 754cc4364822be5fda528f54042fb22a84f19924; exact-head main CI 39622251466 SUCCESS source only. QA branch #572 DRAFT, not merged.

## #572 old HEAD was not without a workflow

Prior QA head f7cb4d96a22d32b10679f844c8c0c878d9d05bc4 has CI 39609482502 **FAILED** with Windows NW_DURABLE_READY timeout and preserved red source negative tests. This is not a missing-run status. Next new QA head must be verified independently.

## Exact SHA/source CI records

| PR | Head | Base | CI | Result | Scope or limitation |
|---|---|---|---|---|---|
| #635 | 5a52fd6eccbf | c429ed9c7eb6 | 39624326925 | PASS | QA17 independent adverse CORE/ROOT source tests only, parent stack not main |
| #636 | 56e9d97f65de | ea4229b9ed34 | 39625147216 | PASS | QA17 protected signed CORE enrollment/revoke source only, not live signed Broker |
| #637 | 474838810ecc | 4e0cb8f5a00d | 39625291153 | PASS | QA18 hostile external CAS simulation, not a physical rollback-independent PostgreSQL witness |
| #638 | 95304300649a | a3946c1f25b8 | 39625275778 | FAIL | Separate exact-head 100cycle test workflow #39625276215 PASS; standard CI #39625275778 Windows actual Authenticode UNAVAILABLE and parent ACL null FAIL |
| #639 | 35acaf6cc977 | ea4229b9ed34 | 39625620173 | PASS | QA20 signed Broker installer/CORE source adversarial tests, no physical signed rollout |
| #640 | 91f1426f5378 | 9266f9b65a1f | 39626203944 | FAIL | Two semantic source test FAILs: cancel before Native write wrongly MUTATION_UNKNOWN rather than CANCELLED; later cancel overwrites settled pending Native mutation UNKNOWN, plus 2-agent E2E failure; no test skipped |
| #641 | a6906b4f45c3 | 9266f9b65a1f | 39626185867 | FAIL | Two-Hub CAS/fence QA on #634 branch; inherited Node E2E red and Windows fast-exit red; individual new suite PASS in author's report only |
| #642 | 87644090113d | 754cc4364822 | 39630395647 | PASS | CORE UI source CI exact HEAD SUCCESS; real high token/physical Broker status unverified |
| #643 | 3e5117abbc44 | c429ed9c7eb6 | 39626754232 | PASS | Owner revoke/re-pair while elevated execution source negatives; no real high token |
| #644 | 669e0779562e | ea4229b9ed34 | 39627727657 | PASS | Broker crash/rollback/stale DPAPI/offline revoke source negatives; no real signed installer |
| #645 | f7c36309bf54 | 754cc4364822 | 39626967547 | FAIL | UAC Remote Assistance source coverage, hosted Windows Job fast-exit FAIL; consent is never remote approval |
| #646 | 65b96fa17b70 | 754cc4364822 | 39627296601 | FAIL | QA24 exact SHA integration DAG/collision source, hosted Windows Job fast-exit FAIL |
| #647 | 3b3f26d068f1 | 754cc4364822 | 39627227248 | FAIL | W26 native handle provenance negative QA source, inherited Windows Job fast-exit FAIL; no live file handles/ACL tested |
| #648 | 9d9d11b9326d | 754cc4364822 | 39628249630 | PASS | QA29 elevated audit provenance source CI 39628249630 and independent QA29 workflow 39628250167 both SUCCESS, no live elevated execution |
| #649 | 955cf289b4b0 | cf58e6882e44 | 39628451245 | FAIL | QA30 bounded parser/gzip/per-tenant p95/p99 source; CI Windows fast-exit stdout-first iteration 1 FAIL, remaining jobs green |

## #640: two confirmed real source semantic cancellation failures

- Cancel in gated source read BEFORE any Native write: zero target writes dispatched; expected CANCELLED; observed MUTATION_UNKNOWN. The source test FAILED on GitHub CI 39626203944, not merely a shared Windows Job problem.
- Cancel AFTER a Native write may have been dispatched and ACK may have been lost: pending MUTATION_UNKNOWN must remain unknown despite later cancel. Source test FAILED because the implementation downgraded UNKNOWN. Never replay, forge CANCELLED or infer no effect.
- #640 also has sandboxed WebSocket two-Agent E2E failure in Node24. #641 has inherited source E2E/Windows CI failures. #08 owner fixes production cross-device-transfer-jobs; independent #16 only records/tests acceptance.

## CI interpretation

- #638 separate Windows Job hosted 100-cycle workflow 39625276215 SUCCESS. Full CI 39625275778 still FAILED real OS Authenticode surrogate UNAVAILABLE, inherited parent Modify ACL null; both must be fixed. No signed process attestations.
- #648 dual exact-HEAD workflows SUCCESS, CI 39628249630 and independent QA29 audit 39628250167, only synthetic/evidence command audit with no live high-integrity CORE shell or independent physical postcondition.
- #649 CI 39628451245 FAIL hosted Windows Job fast-exit stdout-before-exited iteration 1. Node22/24 and other jobs green; fairness source not physical 100+ WSS/1GiB.
- #642 later checked exact-head CI 39630395647 SUCCESS (initially IN_PROGRESS at the first snapshot); source UI checks only, not a physical elevated CORE token.

## R01-R22 four-level acceptance

Source 6 PASS, 6 FAIL, 9 BLOCKED, 1 NOT_TESTED. All 22 staging/production/original incident statuses BLOCKED.

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

## QA tests and release blocking

- New test/qa-635-649-exact-head-evidence.test.ts verifies 15 exact PR SHA/CI pairs, two #640 true semantic failures, #638 separate 100cycle green/full red, #648 dual green, #649 inherited red, and no physical promotion.
- Existing four source red suites stay active: restored SQLite requestId, missing current-main one-call MCP public API, Hyper-V typed broker, and broad signed CORE/ROOT high-token Broker. No skip or continue-on-error.
- #271 actual historical real legacy Stack/cli.js inherited NT AUTHORITY Authenticated Users Modify. Broker ACL unreadable; do not infer safe elevation.
- #551 first-party Nexowire signed installer and complete signed Agent 1.0.5 rollback/VM canary still unverified despite successful source release contracts.
- #587 joint SQLite journal+authority restore re-admits reserved requestId; #637 hostile CAS green simulator not independent physical remote monotonic authority.
- Physical CORE must be broad real Windows elevated shell via protected version-matched signed Broker after one real LOCAL UAC enrollment, persistent until owner revoke, ROOT maximum 15 min. No actual high token/physical local UAC, exact Hyper-V VM GUID Running readback, or signed two-device rollout.

**Final Acceptance NO-GO**. No main merge, live VM, Agent, UAC, ACL, user files, service changes, real CAS DB, or production deployment.

Artifacts: QA_20261021_PR635_649_EXACT_EVIDENCE.json; 72 PR source snapshots; 27 findings.
