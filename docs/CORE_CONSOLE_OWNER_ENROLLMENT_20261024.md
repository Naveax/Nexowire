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

## Agent integration added; production provider still missing

`CoreConsoleAdmission` now runs at the real `executeCapability` console boundary.
When no separate timed grant is active, console mutations must use the protected
provider's native dispatcher; they never fall through to the legacy GUI switch.
Each request reserves a unique ID before any await, snapshots the input, binds a
fingerprint and exact enrollment epochs, fetches current authority without a
positive cache, and rejects stale/invalid evidence. SAFE, CORE OFF, wrong binding,
changed generation, lock/Secure Desktop, missing native admission and lost ACK
are rejected. STOP aborts pending work and latches this controller closed.

The installed composition root deliberately constructs the controller **without
a provider**. Its effective status is `CORE_CONSOLE_PROVIDER_UNAVAILABLE` and
inactive. No remote field, environment flag, FULL mode or policy-eligible
certificate installs a provider. The provider interface is not a signed native
implementation. Its atomic external authority/dispatch/revoke and durable replay
requirements remain mandatory; the in-process duplicate-ID guard alone does not
provide restart/rollback-resistant replay protection.

Console status separately exposes `core.preferenceEnabled`, `core.localEnrolled`
(current verified eligibility), `core.active` and `core.state`. Unknown authority
does not imply enrollment or ACTIVE. An indefinite active provider uses
`mode: core`, `expiresAt: null`, `remainingMs: null`; ordinary grants stay timed.
An attempted `mode: core` enrollment currently fails explicitly, without silently
opening a timed prompt. A working on-device enrollment UI is still missing.

Timed consent now carries a cancellation epoch and connection lifetime. STOP,
disconnect and timeout invalidate delayed approval, and wall-clock rollback
cannot extend an existing timed grant. The prompt launches pinned Windows
PowerShell with a restricted environment. Approval flags supplied remotely are
rejected. CORE provider dispatch is separate from Windows elevation/UAC.

The added provider-fixture tests exercise the actual Agent routing and Ed25519
policy; their positive effects are explicitly synthetic. Windows consent tests
inject decisions and never approve a real prompt or inject physical input.
The hosted Windows job now explicitly runs these tests. They do not constitute
installed enrollment, persistent STOP, real restart or physical acceptance.

## Required production implementation and acceptance still missing
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
