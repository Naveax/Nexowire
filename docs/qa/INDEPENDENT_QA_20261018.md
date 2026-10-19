# Independent Nexowire R01-R22 Final Acceptance | 2026-10-19

**Exact main snapshot:** `cb819d17ee581093d39626f13e985976def17f30`. **QA PR:** [#572](https://github.com/Naveax/Nexowire/pull/572). **Final Acceptance: BLOCKED.**

## Windows browser-live CI 39155406551: actual failure and bounded QA fix

Job 117757746526 failed the first durable process stdin/stdout reattach test with PROCESS_NOT_RUNNING at src/agent/process-manager.ts:369. The sidecar received the control request but reported that its shell was not accepting input. The second durable process recovery test and six other CI jobs passed. This was NOT a browser DOM, EBUSY cleanup or WINJOB_STDOUT failure. Root cause of the worker exit/pipe state is not independently established.

The QA test now requires a unique READY record emitted by the real child shell before the first stdin write. An early exit explicitly fails with worker status, exitCode and bounded output. There is no retry after UNKNOWN, no skipped test, swallowed failure, disabled security gate or blind increase to test timeout. The GitHub exact-head Windows CI must verify the new test. The isolated local native helper compilation prerequisite failed, so local Windows durable-process acceptance is NOT_TESTED.

## Independent source/staging/production/original acceptance

Source statuses: 7 PASS, 2 FAIL, 12 BLOCKED, 1 NOT_TESTED. All 22 staging, all 22 production, and all 22 original-incident statuses are BLOCKED.

| Requirement | Source | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 Error attribution and correlation | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R02 Durable Agent operation journal | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 Hub and Agent reconciliation | PASS | BLOCKED | BLOCKED | BLOCKED |
| R04 FULL ROOT CORE and Broker authorization explain | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R05 Constrained filesystem and USB grants | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 Connection epoch and safe reconnect | PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 Windows process child-tree ownership | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R08 Shell and WSL task exit status | PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 Private GUI Broker and foreground focus | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 Git device and artifact SHA checkpoint | PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 Reliability Doctor UI | NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 Scale sockets quotas and capacity | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 Upstream provider safety failure attribution | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R14 Codex OAuth and OIDC | PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 Cross-chat artifact continuity | PASS | BLOCKED | BLOCKED | BLOCKED |
| R16 Native Windows file picker UIA | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 Environment diagnostics | PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 Progress supervisor watchdog | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 Agent lifecycle and safe rollback | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 CAS and idempotent append | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 Physical hardware acceptance harness | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 Independent release and regression gates | BLOCKED | BLOCKED | BLOCKED | BLOCKED |

**P0 anti-rollback R02 and R20 are FAIL.** Merged [#567](https://github.com/Naveax/Nexowire/pull/567) proves that restoring a legitimate earlier SQLite backup can forget a later requestId. A metadata-only Journal.begin can then return created:true. This is a confirmed source replay reservation defect, not a claim of an actual reexecuted user mutation. Require independent durable monotonic authority or equivalently fail-closed backup/restore before release.

## Verified merged source updates

- #566: multiprocess SQLite quota race fixtures; not production D1.
- #567: independent stale-backup anti-rollback negative; release blocker remains.
- #568: device signer TOCTOU and DPAPI staging; not nonexportable hardware key or named Cloudflare Tunnel acceptance.
- #569: synthetic WSS connection fault proxy; not real two-PC reconnect chaos.
- #570: indirect WSL/Terminal GUI wrapper guard; not end-to-end COM/Desktop isolation.
- #571: local protected tenant shares, synthetic fairness and reconnect throughput; no real 24-hour completed tool soak.
- #573: exact two-device hashes on fresh fixture files, NOT live new-chat production Hub retrieval.
- #577/#578: real Codex CLI against synthetic loopback OAuth issuer; real production issuer and owner binding missing.
- #575, #576, #579, #574, #565, #553 and #551 remain DRAFT at the recorded commit snapshots, with distinct source and physical security blockers.

## Independent blocking findings

Machine-readable source: [QA_BLOCKING_FINDINGS_CURRENT_MAIN.json](QA_BLOCKING_FINDINGS_CURRENT_MAIN.json). 11 entries each record affected PR exact SHA, observed evidence, isolated reproduction steps, required fix, source/staging/production/incident disposition.

- **QA-P0-559-HELPER** ([#559](https://github.com/Naveax/Nexowire/pull/559), [#576](https://github.com/Naveax/Nexowire/pull/576)): #576 adds unnamed Job/NWJOB5 and helper hash/file-ID checks, CI SUCCESS; signed publisher/manifest integrity, PROCESS_DUP_HANDLE and production original orphan acceptance remain open. Required: Pin publisher-signed immutable helper manifest, protected Guardian ACL, prevent PROCESS_DUP_HANDLE-based retained Job handles and independently verify kernel membership after physical rollout.
- **QA-P0-553-PATH** ([#553](https://github.com/Naveax/Nexowire/pull/553)): #553 source owner-console grant request/revoke is now implemented in source. Latest exact-head CI 39282648539 queued. Real Agent 1.0.5 still not updated and Node realpath + fs I/O has non-atomic NTFS junction/volume TOCTOU risk. Required: Provide native handle-pinned file-ID/volume checks at point of use, install and test owner-console grant, physically test USB hotplug/reletter and junction races.
- **QA-P1-563-DOCTOR** ([#563](https://github.com/Naveax/Nexowire/pull/563), [#563](https://github.com/Naveax/Nexowire/pull/563)): Old SHA 7a7628c CI failed on Linux. New SHA dbf5099c fixed wrong-platform expectation, live architecture/time override and injected-runner provenance. New exact-head CI #39154336693 completed 7/7 SUCCESS. No real USB/WSL/device physical acceptance. Required: No further source CI blocker at this exact HEAD. Complete real USB/WSL/VM and hardware provenance acceptance before staging/production/original incident PASS.
- **QA-P0-480-556-GUI** ([#480](https://github.com/Naveax/Nexowire/pull/480), [#556](https://github.com/Naveax/Nexowire/pull/556), [#570](https://github.com/Naveax/Nexowire/pull/570), [#579](https://github.com/Naveax/Nexowire/pull/579)): #570 fixes literal WSL wrapper preflight. #579 source reproduces and blocks edited generated UIA helper hash, but signed helper trust, reparse parent race and live owner Default desktop isolation absent. CI 39175699760 was queued at inspection. Required: Require signed/ACL-protected native helper trust with kernel/session provenance, atomic launch and real Common Dialog/focus/GUI isolation acceptance.
- **QA-P1-551-INSTALL** ([#551](https://github.com/Naveax/Nexowire/pull/551)): Source CI/readiness successful but installer still injection-only; no real signer certificate, owner-approved install, two-device rollback. Required: Trusted signed first-party publisher chain and controlled isolated VM/canary rollouts, verified rollback hashes and health.
- **QA-P1-564-FAIRNESS** ([#564](https://github.com/Naveax/Nexowire/pull/564), [#566](https://github.com/Naveax/Nexowire/pull/566), [#571](https://github.com/Naveax/Nexowire/pull/571)): #566 isolated SQLite 600/min race passes, #571 adds protected offline 300/300 and 570/30 share and reconnect fixtures. Actual Cloudflare WSS tenant fairness, 24h verified native completion and billed costs absent. Required: Demonstrate external two-account fair ingress at 600/min, 100+ real WSS, authenticated owner/device, 24h native completion receipts and Cloudflare actual counters.
- **QA-P0-567-ANTIROLLBACK** ([#567](https://github.com/Naveax/Nexowire/pull/567)): Confirmed source FAIL: restoring an old valid SQLite backup forgets a later requestId and AgentOperationJournal.begin() returns created:true; test only reserved metadata, did not replay real mutation. Required: Protected independent monotonic reservation ledger outside the restored DB, fail-closed WAL/backup/Hub/Agent reconciliation and no blind replay.
- **QA-P0-574-GUARDIAN-ACL** ([#574](https://github.com/Naveax/Nexowire/pull/574)): Previously observed Authenticated Users Modify on privileged Broker source; actual live ACL now access denied and Guardian task not observed. Source DACL-only rollback fixture is not live security fix. Latest CI 39282427109 queued. Required: Protect Broker exe/config ACL from Authenticated Users Modify, signed Guardian identity, trusted session/ACL proof and fail-closed owner revocation.
- **QA-P0-575-PROGRESS** ([#575](https://github.com/Naveax/Nexowire/pull/575)): Worker-writable result manifests are not trusted completion evidence without protected Agent seal. Source CI #39155483038 FAILED Windows browser-live WINJOB_STDOUT marker; release readiness separate PASS. Required: Trusted Agent-controlled immutable proof handoff, scoped session generation, reliable Job stdout exit sequencing and actual bot acceptance.
- **QA-P0-565-ERROR** ([#565](https://github.com/Naveax/Nexowire/pull/565)): Merged Error Contract classifier exists, newer E2E follow-up open. Historical #39154519028 failed WINJOB_STDOUT due early ProcessManager exit before stream drain; new source fix in DRAFT, CI #39281948778 queued. Required: Validate stdout drain ordering in exact-head CI, additive operation/correlation IDs and external provider-versus-Agent cause without manufacturing hidden refusals.
- **QA-P0-572-DURABLE** ([#572](https://github.com/Naveax/Nexowire/pull/572)): Exact #572 CI 39155406551 Windows browser-live failed durable process reattach PROCESS_NOT_RUNNING; one other durable test passed. No EBUSY and no WINJOB_STDOUT. No proven source root cause yet. Required: Prove durable worker stdin readiness and guardian process lifecycle; preserve negative failure and run new exact-head CI before any source PASS.

## Physical and trust boundaries

All active physical Agents still report v1.0.5. Neither trusted publisher-signed first-party installer nor Guardian source ACL remediation is physically accepted. Prior Naveax Broker Authenticated Users: Modify observation cannot be treated as resolved because newer ACL readback returned ACCESS DENIED. Never bypass UAC, user desktop ownership, token revocation, filesystem grants or provider refusal policy.

The matrix is pinned to the specified main SHA; PR #572 head after this review is a different SHA from the prior failed CI. Do not mark new exact-head CI successful before observing its actual conclusion. No main merge, live Agent restart/update, disk/USB mutation or billing change was performed.
