# P0 #587: Broker dispatch server wire adapter

**Source only; production NO-GO.** This change provides a request handler for
the existing `/v1/broker-dispatch` protocol. It is not a deployment, a
monotonic CAS implementation, a credential store, a Windows attestation provider,
or evidence that a real service exists. Nothing in this change enables CORE.

## Enforced at the wire boundary

- Reject plaintext connections, missing/malformed credentials, invalid input,
  oversized bodies and unknown routes. Errors contain no credential or payload.
- Resolve the Broker principal through the configured credential authenticator,
  then compare Broker/owner/device/device epoch/session against the request.
- For begin and commit, independently request the protected Broker readback;
  caller-supplied `verified` or HIGH fields alone do not authorize anything.
  The obtained evidence must match the exact Broker, owner epoch and generation.
- Forward begin, commit, revoke and scoped release exactly once; do not retry
  failures. Validate Ed25519 signatures and the full request/owner/device/session,
  generation, Broker, nonce and expiry scope before returning a permit. Validate
  exact signed revoke scope, generation increment, nonce and `drained=true`.
- Authenticate release against the original immutable owner/device/session and
  Broker identity. A release does not demand that an already-revoked grant is
  still current; the backend must atomically match the original claim.
- Require independently verified owner approval before revoke. An invalid or
  unavailable authenticator, readback, approval, backend or receipt fails
  closed. No fallback authority, plaintext listener or signing key is created.

The adapter cannot prove that a callback actually performs protected readback,
that the authenticated credential is safely provisioned, or that a signer is an
independent, non-rollbackable CAS. Its injected dependencies are trust boundaries;
an implementation backed by a forged boolean or test fixture must never be
configured as production. Even a correctly signed receipt cannot establish
physical separation, rollback resistance or true process drain.

## Required provider semantics

The backend behind this handler must own one linearizable, independently
protected authorization and tombstone domain. Begin atomically checks the
current owner/device/session/epoch/generation and privilege, consumes the
request UUID and persists the complete immutable scope before responding.
Commit atomically checks the original claim, current grant and expiration
against revoke; the admission is single-use. A duplicate, lost ACK, expired
receipt, failed check or ambiguous outcome never authorizes another effect.

Revoke fences new admissions atomically, validates the signed owner approval
and yields a signed `drained=true` receipt only after every admitted effect is
actually resolved. Unknown or stalled drain stays unavailable. Release matches
the immutable original claim and never removes the request tombstone. All of
these properties must survive process restart and restore of the authority as
well as Agent/Hub storage. No HTTP wrapper, separate SQLite file, challenge,
local Set, signature or client clock alone supplies those guarantees.

The grant CAS branch #925 also requires `challengeNonce` on its reserve,
revoke and re-pair messages; this handler implements only the separate Broker
dispatch protocol. A real backend must serialize both protocols against the
same authoritative state before either can be accepted for CORE.

## Source tests and remaining acceptance

The handler tests use isolated loopback TLS, ephemeral keys and a **test-only
in-memory backend**. They cover exact-scope positive flow, rejected plaintext,
wrong owner/session, unavailable HIGH evidence, forged/expired/wrong-nonce
receipts, signed owner approval, active drain, and lost begin/commit/release/
revoke acknowledgements. They do not establish actual durable CAS, Windows
token/ACL, protected key custody, worker termination, restore resilience or
physical consent.

Before production: provision an independently operated atomic backend with a
separately protected non-restorable monotonic anchor; protected credentials,
TLS identity and signing keys; a real Broker evidence provider and owner
approval verifier; and externally witnessed two-device reserve/revoke/drain,
lost-ACK, restart and common-restore tests. Until all are independently verified,
keep CORE dispatch disabled, issue #587 open and production NO-GO.
