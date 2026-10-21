# #04 Access: nonce-bound installed Broker & external CAS queue readback

**2026-10-22 — source-only / DRAFT / production NO-GO.**
Parent: #719 (`597191102dabc22e22c7f9822a026bbd12d60c52`).
Owners #03 and #01 were read but not edited.

## Exact cross-owner facts

- **#709** head `b083004b9ab8c18125a428cf74f3e97f7adf4e88`,
  Actions run `39658979397` **SUCCESS**. Its PowerShell audit
  probes the **inspecting process**, not the installed protected Broker.
  #709 addresses Windows hosted protected-tree ACL/path source test
  regressions; it does **not** grant installed Broker HIGH or implement
  independent physically trusted native signer custody.
- **#712** head `62800af17d2a9ce18670dba6a8ac861a5d7f4ba5`,
  Actions `39659225895` **SUCCESS**. Its protected Broker dispatch
  protocol uses fresh 32-byte `challengeNonce`, exact signed remote
  ownerEpoch/grantGeneration, and atomic `beginIfCurrent` reservation
  against revoke/re-pair. Its SOURCE fixture remote CAS is still not
  a deployed independent physical service.
- Parent **#719** head `597191102dabc22e22c7f9822a026bbd12d60c52`
  Actions run `39659394811` **SUCCESS**, status-only and
  never privileged dispatch.

## Missing Access-owner gap addressed

1. `src/product/access-native-broker-proof.ts` now verifies a fresh
   nonce-bound Ed25519 signed *candidate* report from a **separately
   provisioned protected installed Broker signer**, with exact trusted
   PID, creation FILETIME, volume serial, file ID, image SHA/version,
   owner/device/session/grant epochs, high-integrity enabled-admin claim,
   protected parent/import/updater tree, publisher and duplicate-handle
   policy. Values must match a **separately pinned actual installed
   process identity**, not a request callback, UI or self-inspecting
   PowerShell token. A signed source assertion by itself cannot
   establish physically independent token inspection.
2. `src/product/access-queued-job-review.ts` generates a fresh random
   32-byte hex challenge for each review, sends it to both native
   protected signer and external CAS readback, and requires the exact
   challenge in **both independently signed responses**. A historic
   validly signed receipt restored from WAL cannot satisfy the next
   nonce. Native and CAS signing keys must be distinct.
3. The CAS high-water read is now required to independently report the
   current **owner ID, deviceEpoch, sessionEpoch, ownerEpoch and
   grantGeneration**. Even if the old signed readback matches an old
   queued request, a reconnect/re-pair/session rotation that changes the
   current external high-water denies the next privileged step.
4. ROOT expiry is checked at start **and again after the final CAS
   readback**. At `expiresAt` the 15-minute ROOT grant rejects without
   pretending previously dispatched work is stopped. CORE remains a
   durable owner/device enrollment, with **no additional per-command
   Windows UAC** after a legitimate physically witnessed initial
   protected Broker installation.
5. Every synthetic all-green result is still only
   `REVIEWED_ONLY_NO_DISPATCH`, `elevatedDispatchAllowed:false`.
   Actual Windows HIGH token, protected signer installation, #712 remote
   independent CAS deployment and atomic dispatch must be physically
   verified elsewhere. No read-then-check result can eliminate the
   **check-to-execution TOCTOU** without #712's deployed atomic
   `beginIfCurrent`. A possibly dispatched/lost-ACK job remains
   `UNKNOWN_RECONCILE`; NEVER auto-replay.

## Negative acceptance

`test/access-queued-job-review.test.ts`:
- Validly signed foreign or old CAS nonce and native nonce deny;
- Forged native Ed25519 signer, self-inspecting PowerShell token,
  unexpected PID/creation FILETIME, foreign disk/file ID, replaced image
  and signer, untrusted imported/updater parent or duplicate handle
  policy fail closed;
- Same native/CAS signer denied (independent domains mandatory);
- Existing queued revoke and signed stale owner/device/session epoch,
  and now independently advanced reconnect deviceEpoch/sessionEpoch
  even with unchanged numeric generation fail closed;
- ROOT exact expiry **while asynchronous CAS readback is pending**;
- Cached UI EFFECTIVE does not enter proof; no repeat UAC.

## Physical gates

#271 real ProgramData/CLI `Authenticated Users Modify`, protected
Broker ACL unreadable; #551 protected signed installer/rollback not
accepted; #709 independent running Broker high token/process handle not
accepted; #712 external CAS physical rollback-independent service and
native dispatch/revoke-and-drain not accepted.

**No actual Windows UAC, ACL, Broker, service, VM, user files or
production database was modified.** No merge or deployment.
