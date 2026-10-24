# CORE console | Indefinite owner enrollment contract (source-only, blocked deployment)

## Verified original cause
`src/agent/windows-console-grant.ts` has `duration_minutes` 1..60,
stores the local grant in process memory, and requires it for foreground
window/input/clipboard mutations even when control-plane access mode is FULL.
The existing CORE owner preference is indefinite but presently *never a
verified native physical console grant*: `CORE UNLIMITED` is a control-plane
request, not a Windows user consent/token.

## Proposed mode
An explicit **on-device**, owner-approved enrollment may have an indefinite
*revocable* desired lifetime (`expiresAt: null`). It must not inherit the
60-minute interactive lease. Unlike a one-off physical session, its effective
authority must continuously reflect the current authenticated owner device,
installation binding, grant generation, owner epoch, revoke epoch and protected
local signing key. SAFE/CORE-OFF/Bridge-OFF/re-pair/owner change revokes it.

The new source-only `evaluateCoreConsoleEnrollment` validates the signed
local enrollment, exact installation/owner/device binding, current trusted
readback and desktop state. It deliberately returns `mayDispatch:false`:
eligibility is NOT native authorization or secure-desktop/UAC access.

## Required provider / integration still missing
1. Install a protected local physical-console enrollment flow. A cloud login
   or profile checkbox is not proof that Windows locally consented.
2. Pin the local issuer public key in an OS-protected store; signed enrollment
   must not accept a remote caller-selected trust anchor.
3. Obtain rollback-independent, authenticated current owner/CORE preference,
   revoke epoch and grant-generation readback from the trusted authority.
4. At each native dispatch, recheck grant and HWND/PID creation identity;
   emergency STOP, screen lock and Windows secure/UAC desktop always deny.
5. Persist registration and revoke tombstones securely across restarts;
   enrollment must not silently restore from an old backup/epoch.
6. Test both `Naveax` and `work-pc` in a controlled authorized staging
   release before deployment, and keep a local physical OFF switch.

No real device installation, console activation, signed HIGH Broker,
physical UI grants, policy bypass, browser/chat automation, or production
acceptance is claimed. The short-lived grant remains unchanged until a
physical provider and integration are demonstrably ready.
