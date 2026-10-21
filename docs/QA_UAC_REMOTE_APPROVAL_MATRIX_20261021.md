# P0 #617 | Worker #27: UAC remote approval capability and negative source acceptance

**Date:** 2026-10-21  
**Baseline:** `main` at `754cc4364822be5fda528f54042fb22a84f19924`  
**Scope:** Independent, source-only documentation and deterministic test fixtures. No changes to Windows Broker, Agent, UAC settings, ACL, remote desktop input, installer, runtime, or any VM. `ReVoltVPN-Ubuntu-Lab` is excluded.

## OS-supported capabilities, without invented permissions

Windows UAC belongs to Windows, not to an ordinary Nexowire browser tab, remote desktop stream, HTTP status, or a `consent.exe` process enumeration. Default Secure Desktop prevents regular desktop/UI automation from reading or approving the prompt.

* **Local owner enrollment:** An authorized Windows administrator can consent to a trusted, Authenticode-signed first-party Broker installer using the **OS-managed local elevation path**. Merely seeing a consent process is not proof of selection, successful installer completion or token elevation.
* **Remote Assistance / UIAccess:** Microsoft documents a **conditional** remote-assistance scenario in which a trusted, signed and securely installed UIAccess application, an authorized Remote Assistance session and a deliberately configured OS policy can allow a remote administrator to see/respond to appropriate prompts. The policy `Allow UIAccess applications to prompt for elevation without using the secure desktop` defaults to **disabled**. Microsoft's documentation expressly says it **does not alter administrator elevation prompt behavior**. Signed UIAccess is not a general-purpose remote UAC clicker or a replacement for administrator credentials, protected install location, UAC or owner consent. Nexowire shall not toggle this policy as an elevation workaround.
* **Generic RDP / browser / headless / private desktop:** A screen image, keyboard channel, WebSocket, remote shell, apparent desktop state or inaccessible secure desktop supplies **no UAC-approval proof**. No silent desktop switching, impersonation, synthetic click, policy downgrade, key injection, or accessibility abuse.
* **Post-enrollment CORE:** Once a real administrator has locally approved installation of a properly signed and ACL-protected elevated Broker, subsequent explicitly owner-authorized and scoped CORE operations can use that **already-elevated Broker** without a new UAC prompt per command. Every operation still requires current owner/device/session and grant epoch, protected image/signature/import/rollback provenance, effective elevated Windows token, capability/payload authorization and revocation checks. A cached enrollment, agent `adminBridgeReady`, HTTP 401 or process count does not establish those proofs.

Microsoft documentation (security behavior and policy, not proof of Nexowire deployment):

- [UAC settings and configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration)
- [UIAccess secure-desktop policy (Windows 10/11)](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-allow-uiaccess-applications-to-prompt-for-elevation-without-using-the-secure-desktop)
- [UIAccess assistive-technology security requirements](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
- [How UAC works](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works)

## Approval/evidence state matrix

The canonical machine-readable synthetic scenario table is `test/fixtures/uac-remote-approval-matrix.ts`, exercised against **real existing** `inspectWindowsUacStatus` and `explainDeviceAuthorization` by `test/qa-uac-remote-approval-capability.test.ts`. Matrix session and UIAccess-policy fields are deliberately **descriptive only**: today's production interfaces do not attest those facts.

| Scenario | Observation | Windows approval / CORE authority |
| --- | --- | --- |
| `consent.exe` visible, local owner not yet approved | `pending` | **UNVERIFIED**, not success |
| `consent.exe` visible and Broker probe *reports* elevated | `pending`; may suggest a **new preapproved** installer job | **UNVERIFIED**; cannot approve or dismiss that prompt |
| `consent.exe` absent | Point-in-time `clear` | **UNVERIFIED**; not proof UAC disabled or prior consent approved |
| Remote Assistance policy disabled | Remote prompt visibility not established | **UNVERIFIED**; local OS flow still required |
| UIAccess policy enabled, Remote Assistance session allowed | Conditional OS-supported **interactive** path only | **UNVERIFIED** until a real human decision and independent trusted result |
| Unsigned/unprotected UIAccess application or generic RDP/headless stream | No trusted UIAccess/approval evidence | **UNVERIFIED**, no click or desktop-policy fallback |
| Secure Desktop access denied / process enumeration fails / invalid count | `unknown` | **UNVERIFIED**, never `clear` |
| SAFE mode or revoked owner | No elevated delegation | **DENY** |
| ROOT reaches 15-minute boundary, owner re-paired, stale grant epoch | Old permission invalid | **DENY**, no automatic replay |
| Already enrolled signed Broker with verified high token, current owner delegation, protected ACL and independent completion evidence | Intended post-enrollment execution path | Requires **physical attestation** and scoped operation proof; **BLOCKED** on current source-only QA |
| Privileged request dispatched then confirmation ACK lost | `MUTATION_STATE_UNKNOWN` at the executor boundary | Independently reconcile; **never blind replay** |

**Note:** `use_preapproved_installer_broker` is a **read-only suggestion**, not evidence that any arbitrary elevated command is approved. `windows_installer_apply` still requires the exact preapproved installer, hash, publisher and argument policy. This QA does not call it.

## Required physical acceptance, not performed here

1. Owner-approved local enrollment of a known signed immutable Broker package and equally protected updater, import-tree and rollback image; prove low-privilege users cannot replace any parent/target file or associated task configuration.
2. Verify **actual** task/service identity, effective token elevation and Authenticode publisher/image integrity from a trusted Windows context. Agent telemetry, remote API responses and `consent.exe` are not substitutes.
3. Verify current authenticated owner/device/session CORE delegation and monotonic epoch/revoke; ROOT only within an effective, session-bound 15-minute lease.
4. Confirm narrowly authorized operation results through independently trusted readback; on lost ACK/partial execution classify UNKNOWN and reconcile before deciding any retry.
5. Treat any unobservable Secure Desktop, denied remote-control grant, mismatched Broker version, stale epoch, failed signature, writable import or unavailable physical proof as **BLOCKED/UNVERIFIED**. Do not manufacture a PASS.

## Focused source-only checks

```bash
npm ci
npm run typecheck
node --test --import tsx test/qa-uac-remote-approval-capability.test.ts
```

These tests use injected synthetic process counts, Broker health doubles and the existing read-only authorization explanation, on either Windows or Linux. No UAC prompt is opened, no OS policy or remote-control session is altered, and no Windows executable or VM is invoked. They prove regression behavior of source interfaces **only**. They do not constitute local UAC enrollment, Microsoft UIAccess qualification, signed Broker certification, physical Windows high-token evidence or end-to-end CORE execution.

**Owner coordination:** #617, #621, #633, #551/#632. Avoid touching #03/#04/#12 implementation paths and keep this test/doc PR draft until owner/integrator review.
