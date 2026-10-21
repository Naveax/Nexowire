# Nexowire #16 | P0 #617 Hyper-V Admin Bridge independent QA

**Reviewed source main** 4c5c810134c020cd04a5ef2be5c1138ea1954ad0; exact-head CI 39596766086 SUCCESS (source only). QA branch PR #572 DRAFT; no live VM/UAC interaction.

## Evidence provenance: observation vs verified authority

- Issue #617 original incident reported: Naveax Agent v1.0.5 Medium integrity, Administrators deny-only, Start-VM -Name ReVoltVPN-Ubuntu-Lab denied (exit 4). RunAs UAC lost confirmation and returned MUTATION_STATE_UNKNOWN. These original reports do not prove a VM state, user consent or successful elevation.
- Separate issue #617 operator read-only recheck (comment 6316181876): WINDOWS_ELEVATED_ADMIN=False, S-1-16-8192 Medium, S-1-5-32-544 deny-only, vmms/vmcompute RUNNING, Get-VM denied VirtualizationException, unauthenticated Broker /health HTTP 401. This was NOT an independently authenticated VMId+Running readback by QA.
- An unauthenticated 401 is an access gate signal only. Running Hyper-V services are not authority over a VM. Consent.exe appearance is not local UAC approval; no secure desktop click/automation is allowed.
- Main source privilegeRequirement(hyperv.vm.start) currently returns standard, and isPrivilegedBrokerCapability(hyperv.vm.start) returns false. Generic shell.exec remains excluded from privileged Broker; do not route it implicitly.

## #618 pure diagnostics and source CI

- Source-only DRAFT #618 introduces hyperv-elevation-evidence.ts with denied/pending/unknown states, no succeeded claim, no Start-VM, no physical approval or independent VM readback.
- #618 isolated eight deterministic negative test results 8/8 PASS were provided by the PR owner for its earlier commit. This is not runtime/physical acceptance. Exact-head CI has been changing with new commits; record status and SHA separately from any cancelled older run.

## Independent QA source tests on exact main

- test/qa-hyperv-617-source-negative.test.ts executed with 5 PASS, 2 FAIL, 0 SKIP. Passing controls: owner policy != OS token, Bridge OFF/foreign owner deny, UAC and physical console unverified, Broker ready bit != authenticated health, shell.exec has no privileged Broker fallback.
- Intentional RED #617 P0: hyperv.vm.start is not marked elevated by privilegeRequirement (actual standard) and is absent from typed privileged Broker allowlist (actual false). No feature implementation is claimed.
- test/qa-release-evidence-617.test.ts validates nine P0 evidence and release gates (policy/token; local UAC; signed/ACL/version Broker; pinned VMId; fresh Running readback; lost ACK no-replay; unauthenticated 401; bridge intent; signed rollback canary).
- Current-main #587 journal snapshot RED, #588 one-call public MCP RED and #572 durable Windows negative cases are preserved; no skip, continue-on-error or replay of an unknown command.

## R01-R22 four-level gate

Source: 6 PASS, 6 FAIL, 9 BLOCKED, 1 NOT_TESTED. **All 22 staging, production and original incident statuses remain BLOCKED.**

| R | Source | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R02 FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R04 FAIL | BLOCKED | BLOCKED | BLOCKED |
| R05 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 FAIL | BLOCKED | BLOCKED | BLOCKED |
| R08 PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 PASS | BLOCKED | BLOCKED | BLOCKED |
| R14 PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 FAIL | BLOCKED | BLOCKED | BLOCKED |
| R16 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 FAIL | BLOCKED | BLOCKED | BLOCKED |

## Independent release requirements

- Explicit typed hyperv.vm.status/start/stop with per-owner/device/host VMId GUID authorization, no user-input command concatenation and no wildcard/name-only mutation.
- Trusted first-party signed Broker/launcher/import tree protected ACL, correct version + local elevated token attestation, secure local UAC physical owner approval, signed bounded helper.
- Unique requestId with external/non-co-restorable monotonic reservation authority (#587). If MUTATION_STATE_UNKNOWN after lost ACK, never blindly repeat Start-VM, stop or restart.
- Independently authenticated exact VMId+State readback with fresh Running after a start and Off after a separately authorized stop, not a tool ACK or vmms/vmcompute service state.
- #271 live inherited Authenticated Users Modify remains P0, #551 signed complete installer/rollback/VM canary absent, both devices still Agent 1.0.5.

No live Start-VM/Stop-VM, Get-VM, UAC RunAs, Broker execute, actual VM inventory, local security settings, services, file mutation or production deploy was performed by independent QA.

**Production Hyper-V privileged operations: NO-GO. Final Acceptance: BLOCKED.**
