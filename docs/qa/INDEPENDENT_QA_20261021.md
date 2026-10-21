# Independent QA #16, 21 October 2026

Main exact HEAD: 37d68d938b9c94b8647b92fb592a2b30c075427c. Main source CI 39558249914 SUCCESS. QA PR #572 DRAFT. Final Acceptance BLOCKED.

## Exact-source CI distinctions

| Branch PR | Exact-head run | Result / scope |
|---|---|---|
| #597 child 2ba9e72 | 39502962661 | SUCCESS; merged to #596 feature branch ONLY, not main |
| #596 parent 33504656 | 39557944551 | SUCCESS; one-call transfer_start/status/cancel with bounded 64KiB child worker, source only |
| #598 parent cf58e688 | 39502304557 | FAILED; Windows Job stdout-before-exited iteration 8 |
| #608 integration d34c0d3 | 39503650650 + 39503650638 | CI and Release Readiness SUCCESS; combined #576+#598 source only |
| #603 merged 1bd7fdf | 39492384138 | SUCCESS; Ed25519 canonical signature negative, main |
| #601 merged 3a3ff50 | 39492176139 | SUCCESS; byte quota cancellation tombstone, main |
| #551 DRAFT ce4ffdf7 | 39492494717 | SUCCESS source trust contract, NO signed first-party production installer |
| #572 historic 3c9dcaf | 39493135449 | FAILED: Windows NW_DURABLE_READY and two intentionally RED source acceptance cases |

**IMPORTANT:** #597 is merged into #596 but not main. Main public MCP transfer_start remains missing, so main-source RED acceptance is still correct. Parent #596 feature source PASS does not make main or production PASS. #608 green does not rewrite #598 own failed CI.

## Independent source test on current main

Local isolated main 37d68d9: three files test/owner-public-wss-device-issuer-staging.test.ts, test/owner-public-wss-signed-enrollment-staging.test.ts, test/scale-v2-artifact-cancel-fencing-staging.test.ts. Results **21 PASS, 0 FAIL, 0 SKIP**.

Keep test/qa-rollback-source-negative.test.ts and test/qa-transfer-onecall-source-negative.test.ts RED on main: stale SQLite journal restore re-admits a known requestId, and main MCP lacks one-call transfer tools. Separate #587 stronger joint journal+authority co-rollback also remains OPEN. No mutation is dispatched in test. No skip/continue-on-error policy is allowed; QA CI intentionally remains red until main source is actually repaired.

## Four separate acceptance levels

Main source: 8 PASS, 6 FAIL, 7 BLOCKED, 1 NOT_TESTED. Staging 0/22 PASS, production 0/22 PASS, original incident 0/22 PASS.

| Requirement | Source (main) | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 Error attribution and correlation | PASS | BLOCKED | BLOCKED | BLOCKED |
| R02 Durable Agent operation journal | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 Hub and Agent reconciliation | PASS | BLOCKED | BLOCKED | BLOCKED |
| R04 FULL ROOT CORE and Broker authorization explain | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R05 Constrained filesystem and USB grants | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 Connection epoch and safe reconnect | PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 Windows process child-tree ownership | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R08 Shell and WSL task exit status | PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 Private GUI Broker and foreground focus | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 Git device and artifact SHA checkpoint | PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 Reliability Doctor UI | NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 Scale sockets quotas and capacity | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 Upstream provider safety failure attribution | PASS | BLOCKED | BLOCKED | BLOCKED |
| R14 Codex OAuth and OIDC | PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 Cross-chat artifact continuity | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R16 Native Windows file picker UIA | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 Environment diagnostics | PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 Progress supervisor watchdog | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 Agent lifecycle and safe rollback | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 CAS and idempotent append | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 Physical hardware acceptance harness | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 Independent release and regression gates | FAIL | BLOCKED | BLOCKED | BLOCKED |

## Physical security blockers (read-only 21 October)

1. P0 #271 Naveax actual icacls on C:\ProgramData\NexowireStack and executable cli.js: inherited Authenticated Users:(I)(M), i.e. untrusted Modify persists. Protected Broker icacls ACCESS_DENIED exit 5 on both machines means UNKNOWN, not safe.
2. P0 #587 joint backup rollback of both journal and SQLite authority re-admits previously reserved B; independent remote or otherwise non-co-restorable monotonic reservation/CAS trust is necessary. No actual mutation was replayed.
3. #551 trusted release: no proven first-party signed Nexowire installer, full signed 1.0.5 rollback archive, authorized Windows VM outage rollback or two upgraded real-Agent canary. Both devices still Agent 1.0.5.
4. #596 branch large storage and one-call 221KiB loopback prove only source; real signed 1GiB cross-device source/target offsets, WAN reconnect and hash/atomic publication remain untested.
5. #598/#608 combined bounded 9.5 MiB inbound/outbound HTTP and up to four large parsers source; no claim that an upstream ChatGPT/provider message size is controlled.

## Evidence and controls

Machine-readable: QA_20261021_EXACT_HEAD_EVIDENCE.json; PR_SOURCE_AND_RELEASE_GATES.json (47 PRs); QA_BLOCKING_FINDINGS_CURRENT_MAIN.json (18 findings); cross-project-final-acceptance.json (22 R statuses). Independent 2026-10-21 evidence validation test added to CI.

No main merge, no Agent/Hub/Broker restart, no ACL/UAC/USB mutation, no user-file transfer, no signed installer deployment or payment changes. **Final Acceptance BLOCKED.**
