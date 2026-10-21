# NEXOWIRE P0 worker #19 | #670 native provider / Job cross-head QA

21 October 2026. **Test/docs/workflow ONLY. DRAFT, NO MERGE/DEPLOY.** Own #19 files; owner #03 keeps control of scripts, native Job, signed Broker, ACL/provider remediation.

## Immutable source evidence

| Source | Exact HEAD / CI | Windows outcome |
| --- | --- | --- |
| PR #652 | `6dd516086be145d8b0b3876cde22fe40e101acbd`, CI [39629996191](https://github.com/Naveax/Nexowire/actions/runs/39629996191), browser-live job **119325367630** | **36 PASS / 2 FAIL / 0 SKIP** in inherited 38-test Job suite: Authenticode `UNAVAILABLE` vs expected `Valid`; parent Modify ACL `null` vs expected `true`. Fast-exit tests PASS. |
| PR #652 dedicated | QA19 provider run [39629996167](https://github.com/Naveax/Nexowire/actions/runs/39629996167) | 4/4 PASS, does not override full Windows CI failure |
| PR #670 | `cc5f3db53ec38224a1c632bee96d1cf98095b89d`, CI [39633083937](https://github.com/Naveax/Nexowire/actions/runs/39633083937) | All seven hosted jobs SUCCESS, including `browser-live` |

**Critical:** #652 and #670 DIVERGE. Green #670 cannot be applied retroactively to #652. The new #19 DRAFT branch is a direct child of #670, not an unreviewed cherry-pick of #652 implementation.

## Negative acceptance added on exactly #670

- `test/qa-19-windows-job-hosted-fast-exit.test.ts`: byte-identical to the formerly passing #638 QA19 100-cycle fixture at blob `e5db891e5d04ad71770deaa0a4a9f2a744c2a64a`. 100 deterministic serial synthetic `cmd` sessions, alternating stdout/stderr write order, monotonic cursors, exactly-once output before exit, no late post-exit output, and cross-owner PID + creation-FILETIME spoof denials. Never targets a user process or installed service.
- `test/qa-19-windows-native-provider-crosshead.test.ts`: genuine Windows signed surrogate inspected with an independently loaded system Security module. Matching real signature/pinned digest and available .NET parent ACL evidence required. Fake caller `Valid` and `Get-Acl` functions, even after removing the module from the caller runspace, cannot forge signer or protected ACL. Authenticated Users Modify on a **test-created TEMP parent** with protected leaf/parent DACL is an unsafe inherited grant. Stale then attacker-paired loose SHA256 manifest cannot become an independently signed publisher or release.
- Explicit `UNAVAILABLE` / `parentBroadWriteGrantFound=null` test-only **negative state** is checked without simulating a real OS provider outage. Disabling protected Windows system modules to fake a physical outage would be unsafe and would not be an independent witness. **Do not call this a real provider-unavailable physical reproduction.** Missing native provider in positive tests causes FAILURE, never a skip.
- `.github/workflows/qa-19-windows-native-crosshead.yml` compiles disposable source Job helper and runs the two new QA19 files on actual GitHub-hosted Windows; no `continue-on-error`, conditional skipping, elevated dispatch, or hidden red tests. Inherited full `browser-live` continues unchanged.

## Security boundary and decision

`Signed Windows OS surrogate Valid` is merely OS signature proof, **NOT** Nexowire pinned publisher, trusted signed release/rollback manifest, installed high-token Broker, owner/device CORE epoch, full parent/import/updater ACL, or `PROCESS_DUP_HANDLE` boundary. `productionReady=false`, elevated CORE dispatch OFF and **product NO-GO** regardless of source test result.

No installed Windows Agent or Broker launched, no UAC click, no service/VM, no ReVoltVPN-Ubuntu-Lab, no OS ACL changes. TEMP ACL changes are constrained to disposable test-owned directories. Full exact-SHA CI and the dedicated Windows QA must be checked separately; do not restart an already active workflow or claim PASS until confirmed.
