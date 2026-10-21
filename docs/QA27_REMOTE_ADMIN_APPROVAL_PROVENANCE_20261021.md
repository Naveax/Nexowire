# P0 #617 / QA #27 child of PR #645: remote-admin approval provenance

**Date:** 2026-10-21. Parent PR [#645](https://github.com/Naveax/Nexowire/pull/645), exact reviewed parent HEAD `f7c36309bf5486ed26cc357f14e5aa703109e9b4`; inherited main ancestor `754cc4364822be5fda528f54042fb22a84f19924`.

**Scope:** New, isolated **test/docs** child. No change to owner-owned CORE, installer, Agent, Broker, GUI, Windows UAC/UIAccess settings, Windows Job executable, virtual machine or production ACL. **Do not touch `ReVoltVPN-Ubuntu-Lab`.**

## OS capability: request for help is not UAC elevation

The Windows `Allow UIAccess applications to prompt for elevation without using the secure desktop` setting is **disabled by default** and applies to **standard-user credential prompts** in supported UIAccess flows, including Windows Remote Assistance. It does **not** change UAC elevation prompt behavior for an administrator. Qualifying UIAccess apps must satisfy Windows code-signing and protected-location requirements; a browser, RDP screenshot, remote shell or self-declared `UIAccess` property is not equivalent to a trusted Windows Remote Assistance session. Remote Assistance also requires a legitimate interactive user authorization step, and an eligible path does **not** mean the remote helper has entered valid administrator credentials or Windows approved anything.

Windows references (read-only documentation):
- [Microsoft Learn: UAC settings and configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration)
- [Microsoft Learn: UIAccess and the secure desktop](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-allow-uiaccess-applications-to-prompt-for-elevation-without-using-the-secure-desktop)
- [Microsoft Learn: UAC secure desktop behavior](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-switch-to-the-secure-desktop-when-prompting-for-elevation)

**No QA code changes the policy.** The source oracle's `conditional-remote-assistance` means *a possible supervised path for an authorized human administrator to supply credentials*, not a preapproved credential, active physical-console grant, UAC click, OS-issued proof, or Windows token.

## Independent truth/evidence tiers

| Input / event | Evidence producer | Assertion that is **not** justified | Safe source result |
| --- | --- | --- | --- |
| `consent.exe` process count, PID, remote screenshot or window | Agent/observer/UI | UAC approved, denied or command launched | `pending` observation only; `uacApproved=false` |
| Failed process enumeration, `FORBIDDEN` secure desktop query | Untrusted observer, incomplete coverage | No prompt / UAC approved / remote has access | `unknown`, no click or switch |
| Physical console grant `active:false` | Console-approval status | Local-console human approved | Local-console route **UNAVAILABLE**; remote-assisted path still independent |
| Owner explicitly authorizes **Windows Remote Assistance**, verified remote helper, signed UIAccess protected install, applicable standard-user policy enabled | OS-supported *interactive* path, not UAC result | Elevated token obtained / install succeeded | `conditional-remote-assistance` and **manual credentials still required** |
| Administrator consent prompt + UIAccess policy enabled | Windows administrator UAC policy | UIAccess overrides administrator prompt | **UNAVAILABLE** in this particular UIAccess standard-user workflow |
| Native installation/approval receipt with owner/device/enrollment-session/request/nonce, pinned publisher/image/import hashes and ACL evidence | **Independent trusted Windows verifier required** | A JSON receipt or `source='trusted-native...'` proves authenticity | A synthetic test may reach `CONTRACT_CANDIDATE` only; production approval **UNVERIFIED** |
| Authenticated signed, immutable, protected high-token Broker with current owner delegation epoch, CORE enabled, command preapproved, no revoke, independent status/postcondition | Proposed trusted Windows executor | `adminBridgeReady`, port 43112, HTTP 401 or CORE UI preference prove this | A future genuinely enrolled Broker **may dispatch** authorized operations without per-command UAC; physical evidence **BLOCKED** here |
| Dispatch may have occurred but ACK lost | Remote transport | Failure implies not executed or success implies completed | **UNKNOWN / reconcile**, no blind retry |

This separation matters: the local *enrollment* permission does not implicitly authorize new owner epochs or every future command. After one legitimate enrollment, per-command **UAC prompts** need not recur, but per-command **owner/capability/session/revoke checks** must recur. A failed or unverified Broker must not silently `RunAs` each command, click UAC, or downgrade Windows security policy.

## Independently exercised source interfaces and threat coverage

`test/qa27-remote-admin-approval-provenance-negative.test.ts` imports and executes the existing production `inspectWindowsUacStatus`, `explainDeviceAuthorization` and `capabilitiesForPlatform`. It also uses the **test-only**, side-effect-free `test/fixtures/qa27-remote-admin-provenance-oracle.ts` to express future physical acceptance requirements. The oracle intentionally returns `uacApproved=false` and `actualCommandExecuted=false` even for its strongest synthetic candidate. A test-injected `independentVerifier() => true` is **NOT** a real signature/Windows verifier: it only simulates a required interface boundary.

Cases include owner-assisted Remote Assistance without physical-console permission; unauthenticated or unapproved helper; unsigned/user-writable UIAccess; default-disabled policy; administrator-versus-standard-user prompts; generic RDP/browser/headless; forged `consent.exe` or fake Broker health; inaccessible Secure Desktop; provenance owner/device/request/nonce mismatch; publisher/SHA/import trust/parent ACL failure; non-high token; incomplete install; duplicate receipt; stale/future timestamp; failing independent verification; revoked/stale CORE epoch; command not preapproved; wrong session; Broker version mismatch.

## Exact SHA reproducibility

```sh
npm ci
npm run typecheck
node --test --import tsx test/qa27-remote-admin-approval-provenance-negative.test.ts
```

The repository's `npm run check` invokes the Node.js 22/24 test jobs, so both suites exercise this new source fixture. Test files perform **no** live PowerShell, COM, UIA, native Windows API, network elevation RPC, VM control or filesystem modifications beyond normal test runner behavior.

### Explicit inherited CI classification

Parent PR #645, SHA `f7c36309bf5486ed26cc357f14e5aa703109e9b4`, Actions run `39626967547`: Node 22/24 **SUCCESS**; Windows `browser-live` **FAILURE** in existing `test/windows-job-owner.test.ts:216` fast-exit stdout/stderr before `exited` status (iteration 4). That test and the Windows Job implementation are *not* modified by worker #27. The child CI must preserve actual PASS/FAIL/BLOCKED per job, **not skip/disable/rerun** the failing check simply to report green. No hosted outcome establishes trusted physical UAC approval or high Windows-token enrollment.

### Physical release acceptance (out of scope)

An authorized Windows administrator must independently attest the enrolled Broker's exact signed running image and imports, publisher, protected parent/updater/rollback ACL, effective high token, owner/device/session approval linkage, current ROOT/CORE grant and revoke epoch, and operation-specific completion with authenticated readback. **BLOCKED until those native proofs exist.** No secret/token/password bytes should be written to logs or fixtures.
