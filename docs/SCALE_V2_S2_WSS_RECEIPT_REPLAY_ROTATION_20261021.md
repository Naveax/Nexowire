# S2 operator-signed WSS receipt replay, rotation and owner-scope acceptance

Date: 2026-10-21; base main 754cc4364822be5fda528f54042fb22a84f19924.
**STAGING-ONLY, production NO-GO.**

## Source gap reproduced on unchanged main

The issuer's signed DEVICE-PROOF nonce was already consumed atomically in
proposed_owner_wss_enrollment_nonces (device_id,nonce) with a UNIQUE key.
Owner quota frame nonce and logical invocation idempotency are also separately
enforced by owner quota RPC.

However, a verified operator-signed ENROLLMENT RECEIPT could establish more
than one independent lease across WSS reconnects within the receipt TTL.
The pre-fix regression was observed with a real negative source test:
"same signed owner receipt must not create a second WSS lease on reconnect"
FAIL: Missing expected rejection. This is a missing one-use WSS session
admission guarantee, NOT an observed duplicate quota debit or Windows elevation.

## Narrow WSS-owner source fix

- Add ProposedOwnerWssSqliteReceiptJournal to the STAGING
  owner-public-wss-enrollment-lease-proposal.ts.
- Add an explicitly staged SQLite table
  proposed_owner_wss_consumed_receipts with unique SHA256 receipt identity.
  The identity binds verified operator ID/key ID, account, device, session,
  profile revision and canonical receipt signature. INSERT is atomic in SQLite.
  Duplicate, unavailable, locked or missing journal fails closed.
- ProposedOwnerPublicWssEnrollmentLease.establishOnce requires an actual
  operator-owned durable journal; performs independent signed owner-context
  verification, consumes the signed receipt before transport, and independently
  rechecks current authority after claim. If owner is revoked during claim,
  the receipt stays burned. A failed dial cannot be silently retried with
  the same receipt: obtain new owner-approved device nonce/enrollment.
- ProposedEnrolledOwnerQuotaWsSession.connect now REQUIRES the trusted journal
  and calls establishOnce before constructing its outbound WSS socket.
- The existing establish API remains verification-only for source/tests and
  MUST NOT be used to authorize an outbound WSS connection. Standalone
  ProposedOutboundQuotaWsClient quota calls continue requiring independent
  owner-signed per-frame authentication. No CORE/ROOT/Broker access granted.
- All new DDL/test fixtures are disposable staging resources only; no live
  database, Cloudflare or installed Agent modified.

## Independent negative and boundary tests

- Same signed receipt rejected on reconnect and after closing/reopening
  the *same real SQLite file*.
- Two concurrent acceptance calls on one DB: exactly one succeeds.
- Independent SQLite handles representing two Hub processes on the same
  file: exactly one succeeds; persisted journal count is one.
- Wrong owner receipt signed by otherwise trusted issuer denied before claim.
- Stale issuer key after independently rotated operator key, rotated issuer
  ID/key version and revoked session generation deny before claim.
- New operator key with correctly trusted signed fresh receipt is admitted.
- Owner revoke discovered on authority re-read after durable receipt claim
  blocks session and permanently consumes receipt; old trusted state restored
  cannot replay it.
- Missing journal argument or schema fails before WSS network dial.
- Existing earlier device-PoP nonce, canonical Ed25519 signing, native
  signed WSS TLS1.3 CA/SAN/SPKI and owner-scoped quota regression suites
  remain covered. Overall local WSS+quota+pairing/CORE regression 160/160.

## Security limits and rollout blockers

- Receipts issued with identical operator-signed fields in the same
  millisecond may have identical Ed25519 signatures, because staging
  enrollment v1 does NOT contain a unique receipt/jti nonce. The journal
  fails closed for a second identical receipt even if its device-proof nonce
  differs. Proper protocol v2 unique receipt ID is a separate owner decision.
- This journal MUST be backed by an operator-protected durable SQLite file
  shared across authenticating Hub instances; a disposable, restored or
  caller-controlled database defeats global one-use semantics. No independent
  monotonic anti-rollback authority/ACL protection is claimed. Cross-machine
  distributed CAS (two independent filesystem hosts) was NOT tested.
- Key rotation and owner revocation rely on fresh, independently
  authenticated trusted state. The sample static operator reader alone
  cannot attest real Cloudflare issuer key rotation or prevent authority DB
  rollback. Real OAuth issuer/session epoch and managed trust root BLOCKED.
- Tested Windows Software/Platform CNG Ed25519 unavailable; ECDSA P-256
  supported as an algorithm but physical TPM persistent non-exportability
  unproven. DPAPI CurrentUser is NOT TPM.
- No live Named Cloudflare Tunnel, real operator domain/TLS cert,
  Broker high-integrity token, approved CORE delegation, service account,
  VM, UAC, Agent restart or 100+ concurrent WSS acceptance.
- PR #612 device-proof async input pinning is independently OPEN/DRAFT and
  not overwritten here; it should be integrated by its owner before
  production. This branch only touches WSS lease, disposable receipt DDL,
  negative test fixtures and this document.
- #596 artifact store, #551 installer and #617 CORE implementation untouched.

**Verdict: SOURCE TEST ACCEPTANCE ONLY. PRODUCTION NO-GO.**
