# Scale v2 S2: Device-PoP operator WSS enrollment issuance (STAGING)

This change connects the **existing trusted owner SQLite** account/device/session and Ed25519 public-key ledgers to an operator-signed WSS enrollment issuer. It does not create a public listener, OAuth issuer, key escrow, customer entitlement or deployment.

## Issuance protocol
1. Device creates a unique nonce and signs domain-separated canonical request bytes with its existing Ed25519 private key. The signature binds device ID, nonce, timestamp and SHA-256 of the bearer; neither token nor private key is copied into the returned enrollment.
2. Owner first-party authenticator resolves account ID and session generation independently of input account claims.
3. A single owner-host SQLite BEGIN IMMEDIATE checks enabled account/session, enabled device ownership, enrolled device public key, enabled operator revision floor, trusted monotonic time and device signature. Nonce replay is denied via a unique key in a separate enrollment nonce ledger.
4. The operator private Ed25519 key signs the existing exact-versioned WSS profile envelope, with hostname, CA and SPKI chosen from immutable operator configuration, not MCP tool arguments or HTTP headers.
5. The transaction commits the consumed nonce and monotonic account timestamp. On failure it rolls back, without issuing a reusable profile. Clients verify it using their independently pinned operator key and live lease checks.

## Scope and release blockers
This uses a **test-only** account/token authenticator and an ephemeral operator signing key. Real OAuth identity provider, production key storage or key rotation (DPAPI/HSM), registration and proof-of-possession onboarding, nonce retention management, online revocation telemetry and public HTTPS ingress are not implemented here. Production must enforce server-side owner/capability authorization for each tool and cannot trust an owner's customer-controlled local database as SaaS metering. No live services, DNS, firewall, paid usage or quotas are changed.

The new migration SQL is a disposable staging fixture only, not an approved production migration. Acceptance still requires independent real devices, off-tailnet transport tests and provider limit/cost evidence.
