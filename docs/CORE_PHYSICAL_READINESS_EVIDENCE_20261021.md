# CORE physical-readiness witness | 2026-10-21

This isolated #10 source-only module **formats untrusted observations**; it does not install an elevated Broker, authorize a Windows command, grant a ROOT/CORE lease, read secrets, click UAC, or start/stop Hyper-V VMs. The source of truth for owner control-plane decisions remains `src/security/authorization-explain.ts`; #617/#618 own protocol-level Hyper-V elevation evidence, and #04/#323 own verified device enrollment.

## Actual local read-only observations

- **Naveax native Agent 1.0.5**: Windows process token `S-1-16-8192` (Medium) and Administrators group `S-1-5-32-544` *deny-only*; role-admin false. `Get-VM -Name ReVoltVPN-Ubuntu-Lab` was read-only and failed `VirtualizationException`: VM state **UNKNOWN**, not Running or Off.
- **Work PC native Agent 1.0.5**: same Medium/deny-only/not-admin facts. Read-only Hyper-V query failed `VirtualizationException`: VM state **UNKNOWN**.
- Both hosts have a TCP **LISTEN** socket on loopback Broker port `43112` (one listener each). **No HTTP/authentication/version probe was sent**. A listener, or even an unauthenticated 401, never proves Broker token, protected signing, compatibility or an elevated task.
- **Naveax** `C:\\ProgramData\\Nexowire` inherits broad **Modify** ACEs from parent. **Work PC** equivalent inherits broad **Write** ACEs. This is a **security NO-GO warning for a privileged helper root**. Principal names, complete ACLs, SIDs, tokens, URLs and confidential contents are not reproduced. Effective runtime token access, binary/import signer checks and trusted parent path identity remain **NOT TESTED**. Readable ACL != trusted ACL.
- The native Agent process version is **reported** as `1.0.5` by the device registry, not attested executable build/hash; the live Broker binary and exact startup source version are **UNKNOWN**.

## Evidence contract

`CorePhysicalFacts` accepts the **caller-claimed** owner mode and observations; `CorePhysicalReport` always emits `source=untrusted-readonly-observations`, `originCryptographicallyAttested=false`, `effectiveElevation=not_proven`, `authorizationGranted=false`, `mutationPerformed=false`, and `vmEffectVerified=false`. No caller-supplied `claimedOrigin=live_readonly` or green boolean can mint an elevated capability.

This intentionally separates **requested CORE** from **effective elevated execution**. Normal approved bootstrap and persistent signed delegation can be designed and tested by the respective owners; this formatter is not an executor, and is not installed into the live Agent.

## Small fixture and release gates

Deterministic in-memory fixture only, no production file, no 1 GiB artifact or network round trip. Verify Medium, deny-only, broad inherited write, listener-not-auth, unknown VM, CORE revoked and ROOT expired, and forged all-green caller reports. Exact-head CI must be verified on a DRAFT PR.

Production gates remain open: verified signed/protected elevated Broker and imports, independent authenticated version-matched health/token proof on `43112`, owner/device durable CORE enrollment and revoke, ROOT lease/session expiry, effective ACL, authorized VM readback, #271/#551/#587 dependencies. No hidden UAC Secure Desktop interaction or VM mutation.
