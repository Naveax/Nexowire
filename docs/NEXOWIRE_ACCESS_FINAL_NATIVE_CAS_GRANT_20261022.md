# Nexowire #04 — final native-boundary CORE/ROOT authority contract

**2026-10-22, source-only, isolated child of #757. Production NO-GO.**
No Windows service, installed Broker, UAC, ACL, Agent, VM, elevated
PowerShell or production external CAS operation was executed.

## Source cross-review

- #757 exact HEAD `93acbb7a4e830485ce94015b3c76837a3fcdad34`,
  GitHub Actions `39736445337` **SUCCESS**. Its double signed CAS
  `revoking:false` read-only check can still race after the last read.
- #747 exact HEAD `13acf85b063cd87e5bcf7a43e4fb650f63a30f42`
  independently tests a **hypothetical** final atomic native boundary
  injected into #712's actual callback. #731's real unsafe
  reserve-before-revoke/deliver-after-revoke interleaving is not fixed
  by Access readback or old signed permit.
- #756 exact HEAD `d4ed32f72701e5157929cbb9d36bdf0a90fc0d57`
  adds actual Win32 TEMP fixture file access and PID creation FILETIME
  / image path / DUP_HANDLE probe. It intentionally reports
  `installedBrokerProcessAttested:false`,
  `effectiveBrokerHighTokenVerified:false`,
  `separateLowPrivilegeCallerBoundaryVerified:false`,
  `protectedJobHandleInheritanceAndDaclVerified:false`.
  A synthetic PowerShell process or its own token is NOT the
  installed protected signed Broker.
- #712 latest `1d78a7a9174e91e3b6baaa1319a063917391a64f`
  has source nonce-bound `beginIfCurrent` and remote revoke semantics;
  deployed independently protected physical CAS/native effect
  serialization has not been accepted.

## New Access owner contract

`src/product/access-final-dispatch-authority.ts` models a **strict
dispatch-time source-only eligibility review** which MUST NOT be
mistaken for an executable grant:

1. Revalidates a genuine signed #712 permit with #757's two independent,
   signed post-delivery CAS `revoking:false` fences, current
   owner/device/session epoch and D1 persistent CORE / bounded ROOT grant.
   A cached UI `EFFECTIVE` flag or previously signed record is not
   an admission control.
2. Issues **another random 256-bit launch nonce** and requires a
   separately pinned signed protected installed native Broker
   process identity at the launch proposal: native PID,
   creation FILETIME, file ID and SHA256/version, high-integrity enabled
   Administrators claim and protected import/updater and handle
   boundary as defined in `access-native-broker-proof.ts`.
   This is not proof of actual installed Broker when only fixture
   signing keys are present. #756 TEMP witness does not qualify.
3. Requires a **distinct externally signed final CAS grant**, minted
   for this exact finalNonce and original permitNonce/dispatch ID,
   fingerprint/capability, same owner/device/paired epochs and
   generation, ROOT/CORE mode, plus precise *pinned native Broker*
   process PID+FILETIME+image SHA. It must deny revoking/revoked,
   expire within <=1500ms, and match an independent server-provisioned
   CAS signing key. It rechecks login, original permit, final grant,
   and ROOT grant expiration against the actual clock **after** remote
   calls. At precisely the 15-minute boundary ROOT is DENIED.
4. A successful SOURCE fixture returns
   `FINAL_SOURCE_CANDIDATE_ONLY`,
   `dispatchEffective:false`,
   `canLaunch:false` and `canReplay:false`.
   A signed grant does NOT itself prove the grant was reserved
   atomically with the Windows effect. External owner #01 must
   implement real monotonic CAS `beginIfCurrent/revokeAndDrain`
   **at the same native side-effect boundary**, and #03 must
   independently attest and actually execute from a protected
   HIGH-token installed Broker. #04 never dispatches a shell command.
5. Validly enrolled permanent CORE requires one **legitimate visible
   local UAC bootstrap** for the protected signed Broker only.
   Subsequent authorized CORE commands must **not** trigger a new
   UAC prompt per operation. ROOT uses the same broad administrative
   operation classes but only during an authenticated <=15-minute grant.
   FULL remains broad standard-user, not elevated.

## Adversarial tests

New tests in `test/access-late-permit-review.test.ts` verify:
- Final grant missing, external revoke while pending or foreign Ed25519 signer;
- Old finalNonce/permitNonce, owner/re-pair, session/device epochs,
  generation, privilege, dispatch ID, broker ID and capability;
- Native PID reuse and creation FILETIME drift, replaced image hash,
  different native signer / wrong pinned process;
- Signed ROOT exact T=+900000ms deny, T-1ms source-only candidate;
- Old signed permit expired during final CAS latency;
- Signed stale UI state or possible post-dispatch ACK loss never grants
  execution or a second attempt.

**Blocking physical evidence:** #271 live inherited Authenticated
Users Modify; #551 installed signed Broker+updater rollback chain,
#756 genuinely protected installed HIGH process/handle/image+native token,
#712 independent deployed rollback-proof external CAS and #747
atomic *native effect* fence still unaccepted. No production grant.
