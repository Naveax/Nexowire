# Guardian signing key registry: source-only D1 schema and read-only verifier

The source includes an **inert** migration `0017_guardian_signing_keys.sql` creating a device-bound Ed25519 public signer registry. It has a unique active signer index per device; revoked historical rows remain auditable.

`D1GuardianSigningKeyReadOnlyRegistry.resolveCurrentPairedKey({deviceId, ownerAccountId, credentialBinding})` performs a **read-only** parameterized lookup. It returns no key unless all predicates match simultaneously:

- Exact device ID, owner account and current credential SHA-256 binding against the canonical `devices` row (old pairing and stolen stale key IDs do not satisfy this).
- Device is FULL, win32, online and reports Broker mode with an Admin Bridge-ready signal.
- Exactly **one** active, nonrevoked signer exists. No signer, duplicates, malformed identity or query error fails closed.
- Strict canonical base64url SPKI DER decodes to exactly one Ed25519 public key whose SHA-256 matches the recorded key ID.

This adapter **cannot** add, update, revoke, rotate or trust-enroll a signer, and is not wired into the production Worker. The migration exists in source only and **has not been applied to production D1**. Its deployment and any future signer-enrollment process require separate review and owner authorization.

The repository's signed-receipt HTTP preflight requires an explicitly injected trusted resolver. A valid database row does **not** prove that the Guardian itself is privileged, secure or has an authenticated Hub channel. A future enrollment process must provide (1) owner-approved authenticated pairing, (2) local Guardian source/task integrity and protected private key storage, (3) durable challenge consumption, (4) atomic rotation/revocation, and (5) measured OS postconditions.

Security blocking issue [#271](https://github.com/Naveax/Nexowire/issues/271) remains open. No elevated task control, local Agent update, production Worker deploy, remote D1 migration or encryption-key manipulation occurs in this PR.
