# P0 #587: grant CAS server wire adapter

**Source only; production NO-GO.** The grant HTTPS client requires an authority
supporting reserve, revoke and re-pair with fresh challenges. This handler
validates the wire requests and replies but is not the authority or its storage.
It installs no listener, real credential, signing key or CAS implementation.

## Boundary

- Accept only direct TLS requests and an independently authenticated principal.
  Match its owner, device, device epoch and session to the complete request.
- Pass the exact client challenge to the underlying atomic authority and require
  it to return the same challenge with the response. The handler never appends a
  new challenge to an old unchallenged result. It also validates authority ID,
  UUID, fingerprint, capability, owner/session and grant generation.
- Require separately verified owner approval for revoke and re-pair; check
  generation increments, rotated epochs, new owner, and `coreCleared=true`.
  Inputs are snapshotted before asynchronous approval and authority calls.
- Missing dependencies, invalid proof, unavailable providers and ambiguous
  backend outcomes deny authorization. The handler performs no retries.

Grant receipts use the existing #925 TLS response format, not Ed25519 signatures.
TLS authenticates the configured endpoint and the challenge helps detect a
copied old response; neither proves the backend is linearizable or has not
itself rolled back. An authority that fabricates a fresh answer or replays its
own restored state is outside what this handler can detect.

## Provider and physical acceptance still required

The actual separately operated authority must atomically compare current
owner/device/session/epoch/generation and CORE/ROOT expiry while reserving the
globally unique UUID. It must serialize reserve, revoke and re-pair with Broker
dispatch admission and drain in the *same* authoritative grant state. UUID and
approval tombstones, old owners and revoked generations must survive crash,
failover and any common Agent/Hub/authority restore. The backend must enforce
signed operator approvals as part of its own atomic state transition.

Production also requires a protected non-restorable monotonic trust anchor,
actual enrolled credentials and TLS identity, trusted owner keys, protected
Broker readback, and independently witnessed two-device race, lost-ACK, restart,
drain and joint-restore tests. Missing or UNKNOWN state remains fail-closed;
never replay a mutation as reconciliation. Issue #587 remains OPEN.

The automated tests use loopback TLS, ephemeral keys and an **in-memory test
fixture**. They exercise scope and challenge rejection, a single created result
for concurrent duplicates, expired ROOT, signed owner approvals, lost ACK,
revoke and re-pair. They are not proof of a live service, durable storage,
rollback resistance, protected credentials or physical OS state.
