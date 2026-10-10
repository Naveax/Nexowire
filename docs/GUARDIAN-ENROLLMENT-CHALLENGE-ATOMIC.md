# Durable one-time Guardian signing-key enrollment challenge (source-only)

The previous Ed25519 key proof validates possession of a private key, owner/device/pairing identity and 120-second challenge lifetime, but a transient replay-check callback cannot guarantee atomic consumption across simultaneous requests or service restarts.

Migration `0018_guardian_enrollment_challenges.sql` declares a durable, device-bound, owner-bound challenge table containing **only SHA-256 nonce digests**, current pairing credential digest, fixed purpose, canonical issue/expiry and nullable consumption timestamp. No production migration is executed by this PR.

`verifyAndConsumeGuardianEnrollmentChallenge` performs the cryptographic proof-of-possession verification **before** a single conditional D1 `UPDATE ... SET consumed_at = ?`. The update binds exact request, device, owner, current credential digest, nonce digest, issue/expiry and current clock; the predicate checks that the challenge is pending/unexpired, that its current device still belongs to the owner/current pairing, and that the device is a FULL, online, win32, Broker-ready installation. Exactly one changed row is required; any missing, consumed, altered, expired or re-paired row fails closed.

The result **always** returns `enrollmentAuthorized:false`. A consumed proof is not a trusted key registration, UAC authorization, Guardian authenticity attestation, local protected installation or Windows task action. A future owner-confirmed issuer and protected enrollment transaction must still:
- Use OS CSPRNG for all nonces and register challenges under an authenticated owner session.
- Verify genuine local Guardian identity and protected private key custody independently of arbitrary client JSON.
- Bind registered key rotation/revocation to the same approved challenge, ideally in a single transaction with its consumption.
- Refuse an unsafe elevated legacy Stack until P0 #271 is fixed and independently accepted.

No public route issues these challenges, no enrollment row or signer registry row is inserted, no Worker/Agent deployment runs, and no live task or file ACL is changed.
