# #04 Access: late signed permit, revokeAndDrain and effective CORE/ROOT

**2026-10-22 | Isolated DRAFT source-only child of #741.**
Access owner files only; NO live privileged commands or deployment.

## Cross PR verification

- **#741** HEAD `5c2b39530937f7a929044f1be3f6fb9ad89d8ff8`,
  hosted CI [39677981833](https://github.com/Naveax/Nexowire/actions/runs/39677981833)
  **SUCCESS**. Its queued-review status always
  `REVIEWED_ONLY_NO_DISPATCH`; does not atomically dispatch.
- **#731** HEAD `df239ce88f4b98ba97f29e48495fee86049f8856`
  reproduces a **real source ordering flaw** with synthetic side effect:
  Hub A receives a correctly signed, nonce/ownerEpoch-scoped permit
  that remote CAS reserved *before* revoke began, only **after** Hub B
  enters `revokeAndDrain`. With process-local revoke state, Hub A can
  call the synthetic effect while remote drain waits. A fresh nonce
  defends WAL replay, **not** this cross-Hub late-delivery scenario.
- **#743** HEAD `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`
  brings hosted independent QA and read-only parameter compatibility
  for native image-tree observation. It **explicitly reports**
  `nativeEffectiveLowPrivilegeAccessCheckCompleted=false`,
  `transitiveImportsIndependentlyEnumerated=false`,
  `protectedCompleteImageTreeAttested=false` and
  `processDupHandleBoundaryVerified=false`. A signed abstract
  `highIntegrity` flag cannot be promoted to real installed Broker
  Windows HIGH until those gaps and #271 are physically verified.
- **#712** nonce-bound Ed25519 CAS permits and
  `beginIfCurrent/revokeAndDrain/release` source contract are not
  deployed, externally nonrollbackable native-effect authority.

## Implemented #04 source-only proof review

`src/product/access-queued-job-review.ts` now requires *signed*
`revoking:false` **and** `revoked:false` in the original independent
CAS readback and separately current external high-water. A `revoking`
state must block new privileged steps from the moment revoke begins,
not only after remote drain completes.

New `src/product/access-late-permit-review.ts` models proof validation
**AFTER late delivery of an independently Ed25519-signed permit**:

1. Parse signed #712-schema permit scoped to original owner/device/
   ownerEpoch/deviceEpoch/sessionEpoch/grantGeneration, request ID,
   dispatch ID, fingerprint, capability, privilege and **fresh 32-byte
   challengeNonce**, expiration and server-configured signing key.
   Do not trust a cached `EFFECTIVE` UI, unsigned permit or Agent flag.
2. Require **authenticated, separately signed post-permit CAS fence**
   with exact authority/request/dispatch/nonce plus current owner,
   device and session epochs, generation, `revoking:false`,
   `revoked:false`, matching outstanding reservation ID, and bounded
   observation freshness. Reject #731-style *late, otherwise valid*
   signed permit when Hub B already began remote revoke.
3. Re-evaluate current Access CORE D1 persistent enrollment / ROOT
   current login-bound max 15-minute grant, current protected installed
   Broker signer+process PID/FILETIME/image/file ID and high native token
   *candidate*, fresh separate CAS nonce/readback and external
   high-water. No client `core.active`, PowerShell's own token or
   extra Windows UAC prompt can substitute.
4. Require a **second signed CAS fence** after the potentially slow
   native/remote reads to fail closed if revoke/re-pair/epoch drift
   began meanwhile. At the final wall-clock point, reject ROOT when
   time reaches **exactly** expiry (<=15 minutes after issuance),
   expired permit or revoked owner session. A correctly signed ROOT
   permit may pass **source review** one millisecond before expiration
   and fail at the boundary.
5. Even all-green source checks return
   `CURRENT_SOURCE_ONLY_NO_EXECUTION`,
   `elevatedExecutionAllowed:false`,
   `noPerCommandUacAfterLegitimateEnrollment:true`.
   Access **does not call** a native executable or make an
   authorization token. A revoke can start between the final read and
   an OS effect, so actual deployment must enforce **atomic external
   CAS / local protected Broker execution boundary**, and must release
   unused reservations while draining. #731 is not patched by Access
   alone. Already possibly-dispatched UNKNOWN stays UNKNOWN, never
   auto-replay.

## Exact negative fixtures

`test/access-late-permit-review.test.ts` uses genuine ephemeral
Ed25519 signatures and a deterministic Promise barrier. It covers:

- Revocation begins at a different Hub *after* permit reservation and
  signature, *before* late delivery's authenticated readback;
- Revocation/re-pair after initial readback but before second fence;
- Invalid/stale externally signed fence, revoked/revoking state, wrong
  owner/device/session/authority/request/dispatch/nonce/generation;
- Signed stale permit nonce, foreign signer, owner and capability;
- Cached UI EFFECTIVE cannot override current D1/Broker/CAS;
- Signed ROOT permit near exactly 15 minutes: one valid-before-expiry
  review and rejection at the expiration boundary after async reads;
- Missing native independently protected signer, external CAS proof,
  or possibly dispatched UNKNOWN returns no permission or replay.

**Physical P0 NO-GO:** #271 inherited Authenticated Users Modify
in live Naveax source, protected Broker ACL AccessDenied; #551 signed
installed updater/rollback acceptance missing; #743 high token/image/
transitive import evidence incomplete; #712 remote CAS not physically
deployed/rollback-independent; #731 native execution interleaving
remains unresolved by source-only Access validation.

No #01/#03 files, external servers, installed elevated Broker,
real UAC, ACL, Agent, service or VM were modified.
