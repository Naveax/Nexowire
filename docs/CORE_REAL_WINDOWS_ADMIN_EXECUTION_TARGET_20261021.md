# Nexowire ROOT / CORE: real Windows administrative authority

**Product-owner clarified target (2026-10-21). Source architecture, NOT shipped runtime.** Tracking #322 (CORE), #323 (Admin Bridge), #617 (effective elevation), #260 (Broker version), #271 (protected elevated runtime), #551 (signed installer), #587 (rollback-safe operation identity), and draft #618 (diagnostic source tests).

## The product behavior to build

| Mode | What the AI should actually be able to do |
| --- | --- |
| SAFE | Limited low-risk user actions and read-only inspection. |
| FULL ACCESS | Broad actual **standard-user token** shell/app/files/UI/network management, including destructive actions permitted to that Windows user. |
| ROOT | Broad **elevated Windows** terminal/app/services/registry/files/Hyper-V control via an already-approved Broker, for a session-bound 15-minute authorization. |
| CORE | Broad **elevated Windows** control via an already-approved Broker, with durable owner delegation until owner revokes. No repeated operation-by-operation UAC consent. |

CORE can be intentionally high risk: user-initiated tasks may have irreversible consequences. Those effects are the reason to make the grant clear at enrollment and easy to revoke, **not** to silently downgrade CORE into SAFE or require a separate confirmation for every permitted command. Auditing and truthful effect status should not block legitimate tasks by design. OS access controls and external application/provider permission systems still apply.

The existing product currently falls short: `CORE UNLIMITED` stores a preference and `authorization-explain.ts` returns `PAUSED_UNVERIFIED`, with no attested elevated executor. Neither CORE preference nor ROOT timer alone transforms Medium integrity into a High/SYSTEM Windows token.

## Windows capability path: one approved elevated bootstrap, then full operations

1. **Initial Windows approval / onboarding**: the device owner installs/verifies the signed Nexowire elevated Broker once, using the normal Windows UAC local approval. Publisher identity, protected executable/dependency tree, parent/updater ACLs, intended Windows account and launch task are checked. This is an OS elevation bootstrap, not a prompt on every AI command.
2. **Separate long-lived elevated service and unprivileged Agent**: the Agent remains a normal user process; the Broker is locally installed with the real approved elevated token and authenticated, version-matched loopback IPC. UAC policy and Secure Desktop settings remain unchanged.
3. **Two intentional grants**: ROOT issues an owner/device/session-bound lease lasting at most 15 minutes; CORE issues a durable owner/device-bound delegation with explicit revoke/re-pairing invalidation. No old stale grant or rolled-back journal may reauthorize execution. A reconnect retains CORE only after fresh device/owner/Broker attestation, never by trusting a cached UI badge.
4. **Broad dispatch, not a VM-only allowlist**: for ROOT/CORE, a request like `shell.exec(executionContext=elevated)` or an elevated process API can execute user-authorized PowerShell/CMD/Windows administrative work through the Broker. Typed `hyperv.vm.start/status/stop` offers structured scope and state verification, **not the ceiling of CORE power**. FULL routes the standard user token rather than silently elevating.
5. **Control without constant friction**: after initial signed enrollment and current grant are proven, no extra per-command UAC click is expected. AI can choose task sequence and pursue high-impact user-approved work with ordinary command/audit results.
6. **True status UI**: show `CORE requested` separately from `CORE effective (high-integrity Broker independently verified)`. Display Windows identity/integrity, Broker publisher/hash/health/version, owner, grant epoch, expiry/revoke, last verified execution and resulting side effect. Do not turn an OFFLINE last-seen flag or unauthenticated HTTP 401 into permission proof.
7. **UNKNOWN side effects**: if the connection drops after dispatch, record the same request ID and reconcile actual OS state before deciding what to do next. No automatic double execution. This is effect correctness, not a SAFE policy.
8. **Emergency control**: obvious owner revoke/pause and local recovery pathway, without permanent UAC policy changes. Audit is durable, bounded and does not leak tokens or passwords.

### UAC “AI clicks Yes/No” fallback

The product requirement is legitimate: an owner-authorized AI should be able to administer a real remote Windows session, including consent interactions **where Windows supports an authenticated interactive remote administration session**. However a Medium-integrity Agent/browser UI cannot take over the Secure Desktop or safely pretend that `consent.exe` is an ordinary accessible HWND. Microsoft documents the Secure Desktop boundary and signed trusted UIAccess/Remote Assistance configurations. Windows configuration may permit remote assistance interaction after an explicit local grant; those are independently approved OS paths, not universal `consent.exe` automation.

Therefore:
- **Primary**: if a valid ROOT/CORE grant and elevated Broker already exist, run the action directly in its previously elevated context; **no new UAC**.
- **Bootstrap / broker missing**: request the owner to approve normal Windows UAC locally or in a legitimately authorized interactive remote-admin session. If the OS shows a Secure Desktop that this session cannot access, report `LOCAL_OS_APPROVAL_REQUIRED`; never claim an automated Yes/No happened.
- Do not change `EnableLUA`, `PromptOnSecureDesktop`, Windows protection boundaries, or accept a client-supplied `approved:true` as OS consent.

See Microsoft documentation: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration and https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview

## Acceptance stages and ownership

**Phase 0:** Source-layer mode/elevation truth contract + negatives. #618 is useful but not the actual executor. A verified CORE delegation **does not require a fresh localApproval for each command**; a CORE preference without local Broker trust is not effective. Test FULL-versus-ROOT-versus-CORE, revoked ROOT/CORE, broker offline/version mismatch, UAC unknown, unverified `Get-VM`, VM state spoofing. All tests are source-only.

**Phase 1:** #551 + #271 protected signed Broker installation and owner OS consent. The live Naveax legacy ProgramData `Authenticated Users: Modify` elevated executable tree is a hard release block until owner-authorized fixed and independently attested. Never promote code from user-writable paths.

**Phase 2:** #323/#322 verified ROOT/CORE grant session and owner-derived Broker dispatch. Durable replay-safe requestId and explicit `standard/elevated` execution context; no arbitrary elevation from SAFE or FULL. This is where CORE finally becomes a real feature, not a badge.

**Phase 3:** Local isolated Windows VM test: owner approves Broker once; AI in CORE runs a harmless high-integrity command without a second UAC, then authenticated Hyper-V VM start and independently observed Running; 15-minute ROOT expires; persistent CORE survives reconnection but stops immediately on revoke. Owner-sanctioned high-impact *disposable VM* test demonstrates the mode is not silently SAFE. Negative owner mismatch, rollback, stale epoch, UAC declined and unknown/no-replay remain tested.

**Phase 4:** Physical authorized Naveax acceptance with signed version-pinned binaries, current Agent/Broker, repaired ACL, OS approval, observed Running/Off and owner reversible local recovery. No current implementation or CI result implies these physical steps were completed.

## Two clear non-goals

- Do **not** make CORE equal to “safe shell with warnings” or keep every elevated capability behind mandatory reapproval; the preapproved session is the authorization.
- Do **not** interpret CORE as permission to bypass Windows UAC, access a secure desktop using an unprivileged process, or execute on another owner's machine. The product grant supplies authority **through a Windows-authorized executor**, not by changing the OS rules.
