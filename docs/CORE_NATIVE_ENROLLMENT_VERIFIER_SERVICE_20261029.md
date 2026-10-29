# Independent native enrollment verifier component

Exact parent: `b881976e966085bbd5672c66332132d9befa7211` (#969).
Its CI `40932187292` was completed/success before this work. That result belongs
to the parent only. No parent CI rerun, deployment or native enrollment occurs.

## Completed source boundary

The first WebAuthn consume and D1 enrollment consume are different operations.
Previously the real PostgreSQL component implemented the former, while the
remote D1 transport's one-use handoff existed only behind injected test servers.
This child implements that second permanent consume and the HTTPS handler used
by `RemoteTrustedNativeCoreEnrollmentVerifier`.

`consumeForEnrollment` reconstructs the exact proof from the original stored
authenticator bytes, provisioned credential, signature/counter and full native
owner/device/installation/enrollment/session/LUID/epoch binding. It compares
every supplied proof field, uses PostgreSQL time to limit a new handoff to 120
seconds after approval, rechecks protected native/restore witnesses and current
DB scope, then inserts a unique permanent receipt tombstone. An independent
issuer-key hash from the authenticated D1 request is recorded with the handoff.
This does not retroactively bind that key into an earlier human ceremony.
The eventual protected approval provider must include the complete intended
enrollment key and semantics in its genuine owner ceremony before activation.

Two verifier instances cannot both consume the receipt. Unknown COMMIT, lost
acknowledgement, late acknowledgement or post-commit revoke returns no usable
authorization and never deletes/reopens the tombstone. A separate post-commit
read checks current scope again. Read-only reconciliation can find a committed
record; it cannot turn a failed consume into a successful retry.

`readEnrollmentProof` requires the second tombstone, fresh protected native and
DB binding, and another cryptographic verification of the stored authenticator
assertion. First-stage `readConsumed` remains available for approval service
diagnostics; it cannot substitute for the D1 handoff. Repeat readback is allowed
for an already enrolled binding and does not create another grant.

The explicit operator migration adds `core_approval.enrollment_consumptions`.
The runtime gets SELECT and column-specific INSERT only, never UPDATE, DELETE,
TRUNCATE, owner/key provisioning or schema ownership. An immutable-history
trigger also rejects UPDATE/DELETE by an accidental privileged writer; an
administrator able to disable triggers/restore storage remains outside this
software guarantee. No migration is run automatically at application startup.

## HTTPS composition

`createCoreNativeEnrollmentVerifierHandler` opens no listener. An explicitly
configured off-host host can mount it at POST `/v1/core-native-consent`.
It requires actual TLS 1.3, verified client certificate from the socket, a
protected bearer-to-owner/device/installation resolver, the durable ledger and
a separately protected Ed25519 signer. No forwarded header, Agent-supplied
fingerprint, role, URL, private key or `verified:true` field bootstraps trust.
Credential resolution must bind the authenticated certificate fingerprint as
well as the bearer credential; the handler supplies that exact peer identity.

The two implemented operations are `verify-and-consume` and `current-readback`.
`approve-and-consume`, Agent receipt-ID-only queries, cross-owner scope,
malformed/oversized input, plaintext, unverified TLS peers and unexpected roles
are refused. Protected configuration and nested request scope are detached
before awaits. Responses bind the exact request hash, operation, nonce and
observed time. The handler verifies the protected signer's actual bytes, then
performs another current ledger/native readback after asynchronous signing.
A revoke/logon change during signing suppresses the response without resetting
the receipt. A bounded wall/monotonic deadline and disconnect checks suppress
all late responses. An already started database commit can still finish after
a client times out; the resulting UNKNOWN is never retried automatically.

The production Worker default verifier remains absent. No CLI service,
background task, public port, Windows service, install hook or live client
configuration is added. The existing remote adapter must be supplied a genuine
protected mTLS-capable fetch implementation by the future trusted deployment;
ordinary bearer-only fetch cannot satisfy this server's client-certificate gate.
The owning server must also enforce connection/header/body resource limits and
its protected TLS credential lifecycle.

## Evidence

The existing Linux CI PostgreSQL service runs additional genuine transaction
cases: concurrent verifier instances, exact scoped handoff, replay including a
different issuer, lost/late ACK, expiry, final witness loss, post-commit revoke,
unwritable history and independent readback. The existing restart sequence now
persists and checks BOTH the WebAuthn consume and enrollment handoff tombstone.
No additional workflow is dispatched for the parent SHA.

The HTTPS tests use a real disposable TLS 1.3 connection with a test CA and
separate client/server certificates. Their signing keys, native scope and
ledger are explicitly synthetic. They cover the actual existing D1 adapter,
request/response binding, role/peer/scope rejection, replay, lost ACK,
revocation during signing, wrong signer output, constructor alias mutation and
deadline handling. These wire tests alone do not prove durable storage or
physical approval. The separate SQL tests use the real CI PostgreSQL service.
The local SQL/WASM syntax check is not independent hosting or restart evidence.

## Required real deployment and acceptance

- Protected Windows approval service/IPC and independently measured live
  owner SID, WTS session, AuthenticationId LUID and session epoch.
- Authentic credential registration/attestation and explicit human approval
  of the intended complete enrollment; software test EC keys are insufficient.
- Independent native witness, authenticated restore/provenance controller,
  PostgreSQL host outside Agent/Hub rollback, protected runtime DB credentials,
  mTLS client/server identities and separately held Ed25519 signing custody.
- Official signed package/installer, protected ACL/image/token chain, accepted
  production worker and pending-I/O/zero-association revoke drain.
- Two-device enrollment/revoke/restart/rollback/soak acceptance on Naveax and
  Work PC, after the preceding infrastructure exists.

No user action is valid at a nonexistent native approval window. Until those
dependencies are actually supplied and accepted, `LOCAL_ENROLLMENT_REQUIRED`,
`CORE.active=false`, disabled executor/worker and production NO-GO remain.
