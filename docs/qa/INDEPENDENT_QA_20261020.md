# Independent Nexowire QA #16 | 2026-10-20

**Exact reviewed main:** fda2a2da164ea7c6a2fe2271fc669f1fd623cede. **QA PR:** https://github.com/Naveax/Nexowire/pull/572, DRAFT only. **Final Acceptance: BLOCKED.**

## CI failure classification and isolation

- PR #572 HEAD 6b3d7eddcab9951dd35c9bd190cc7b61a1d078c8 CI 39284185988: Windows browser-live FAILED; durable-process.test.ts: /NW_DURABLE_READY/ timeout. No stdout readiness; do not claim a healthy worker or retry a mutation.
- PR #582 HEAD 0e322c94c1e2ab0e58cf7b95115a03dee6bf1ccc CI 39416566585: Windows browser-live failed fast-exit stdout/stderr before exited, iteration 1.
- PR #597 HEAD ab6d04d45a47f27344903a1ada08019d6ed0ead3 CI 39468688109: Windows browser-live fast-exit output ordering failed iteration 11; Ubuntu Node24 test/artifact-588-single-call-contract.test.ts failed missing transfer_start.
- #596 CI 39416958508 PASS validates bounded isolated 1GiB Artifact Bridge store, not public transfer_start/status/cancel or signed native two-device 1GiB.
- #598 CI 39486329477 PASS validates finite 9.5 MiB ingress/egress and 4 simultaneous large parsers, not ChatGPT platform transport or actual 1GiB device flow.
- Independent QA test/qa-rollback-source-negative.test.ts confirms stale journal copy returns created:true when prior requestId is reintroduced; test is deliberately RED (no destructive mutation). #587 simultaneous J+A rollback is separately reproduced on #582.
- Independent QA test/qa-transfer-onecall-source-negative.test.ts verifies public in-memory authorized MCP tool ABI; durable start/status/cancel missing (RED). No real device or large allocation.
- New qa-independent-negative-acceptance CI job runs BOTH red contracts without skip, continue-on-error, or fake success. It is expected to FAIL until requirements are implemented.

## Four independent acceptance levels

Source: 8 PASS / 6 FAIL / 7 BLOCKED / 1 NOT_TESTED. Staging: 22 BLOCKED. Production: 22 BLOCKED. Original incident: 22 BLOCKED.

| Requirement | Source | Staging | Production | Original incident |
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

## Actual #271 legacy code integrity

- Naveax read-only icacls 2026-10-20: C:\ProgramData\NexowireStack has inherited NT AUTHORITY\Authenticated Users:(I)(M). Its executable cli.js also inherited Modify. Real integrity P0 not resolved.
- Protected C:\ProgramData\Nexowire\privileged-broker ACL query returned Access Denied (exit 5), on Naveax and work-pc. The unprivileged query cannot prove that Broker is safe.
- Work PC legacy Stack folder and executable were NOT_PRESENT. Both installed Agents stayed at v1.0.5, no update or restart.

## #587 independent authority failure

- Source #582 adds a second SQLite authority in a distinct directory, but together-restored old journal and authority share rollback domain and can both lose later B requestId. No actual user mutation replay took place in the negative reproduction.
- Required: authenticated external or otherwise demonstrably non-co-restorable monotonic CAS trust anchor, device/epoch bound, fail-closed unavailable/restore/WAL/cold-crash matrix. Production stays BLOCKED.

## #551 deployment and release prerequisites

- #551 exact-head source CI 39413853520 SUCCESS; strict signed trust contracts exist. Actual Nexowire-owned Authenticode signed installer, complete 1.0.5 signed rollback bundle, process binary identity, Windows VM crash/canary and two-device staged rollout still unproven.
- #574 source CI 39411740328 SUCCESS but cannot remove actual unsafe legacy ACL from #271. Never infer secure ACL from Access Denied.
- #576 source CI 39412019534 SUCCESS but trusted publisher/helper and PROCESS_DUP_HANDLE physical acceptance pending.

## Safety and source-of-truth rules

- Machine-readable main/PR evidence: cross-project-final-acceptance.json, PR_SOURCE_AND_RELEASE_GATES.json (44 PR snapshots), QA_20261020_EXACT_HEAD_EVIDENCE.json and QA_BLOCKING_FINDINGS_CURRENT_MAIN.json.
- RED release tests must remain RED until code/signed device acceptance corrects the demonstrated condition. Passing legacy source fixtures never closes original incidents.
- Live Agent, Broker, Guardian, Windows ACL, UAC, user GUI, USB, user files, cloud deployment and main branch were not mutated in this QA session.

**Final Acceptance: BLOCKED.**
