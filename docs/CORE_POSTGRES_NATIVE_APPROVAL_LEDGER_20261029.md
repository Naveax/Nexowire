# Durable native approval consumption component

This component closes the Map/fixture-only consume boundary of #964. It is an
actual PostgreSQL implementation with a separate migration and least-privilege
runtime role. It is **not** an installed protected Windows approval service,
hardware credential registration, independent OS witness, production hosting,
human acceptance or CORE activation.

## Issue, verify and consume

The independent operator provisions the authority, exact current owner/device/
installation/enrollment/epoch and Windows SID/session/LUID binding, RP and pinned
ES256 credential. The application cannot provision/rebind owners, replace keys,
reset signature counters, erase history or create a credential from an incoming
assertion. Credential pins cannot be rewritten in place; registration must use
a distinct credential and independently accepted provisioning.

The service requires current independent restore/provenance and protected native
binding witnesses before DB access and again inside the transaction. Callbacks
are bounded and receive a detached immutable scope. SQL checks its own primary,
fsync/full-page-write settings and runtime role privileges, serializes on the
authority row and rejects DB clock rewind. Neither `verified:true` JSON from a
caller nor an Agent signature is accepted as a substitute for the provisioned
authenticator signature. Real deployment must supply the trusted callbacks.

Challenge IDs and random nonces become permanent global records. Consume reads
the original full intent and provisioned public key/counter under row locks,
verifies actual WebAuthn bytes/signature/UP+UV, rechecks current native and DB
binding, then atomically updates the counter and tombstones the challenge.
Counterless authenticators still receive exactly one successful consumption.
Duplicate/replay, owner/session/re-pair/epoch mismatch, credential revoke,
expiry, missing native proof or unknown COMMIT fail closed. No retry, deletion,
counter reset or timestamp-only fallback is performed.

Lost COMMIT ACK destroys that connection and returns UNKNOWN while a successful
commit remains consumed. A late ACK is also rejected after commit without
clearing history. Scoped `readConsumed` reads an existing receipt with fresh
current binding witnesses; revoked or re-paired bindings cannot recover an old
receipt by knowing its ID. Readback does not create another approval or grant.
Consume performs that fresh scoped readback AFTER COMMIT before returning; a
concurrent revoke or missing witness then denies the response and leaves the
tombstone consumed. The receipt and signature counter are never rolled back to
make a delayed response look successful.

Every returned receipt retains `coreAuthority=false` and
`physicalAcceptance=NOT_PROVEN`. This storage component does not sign a fake
native enrollment proof or change the existing disabled executor/worker flags.

## Evidence and limits

The existing Linux CI job runs the new suite on its actual disposable PostgreSQL
service with separate migration/runtime roles. It also seeds an approval
tombstone, restarts that real test container, checks that PostgreSQL's process
start time advanced, and verifies replay is still denied. No extra duplicate
workflow or live service is started. Software EC keys and native/provenance
readback in tests are explicitly synthetic. Controlled clock adapters measure
expiry handling; they are not a physical clock/rollback exercise.

PostgreSQL transactions alone do not survive an administrator co-restoring this
DB with Agent/Hub snapshots. Actual independent operation, authenticated restore
controller, TLS/mTLS credentials, protected native service/IPC, genuine hardware
credential enrollment and signing custody remain external requirements. Runtime
connections must use protected verified TLS, e.g. the existing protected PG
pool; the password/unencrypted loopback used by the CI fixture is test-only.

This child preserves the exact six-gate parent
`70ced0ac85fc5a2a6b5e42540906f79a75bf67c8`. It also corrects the diagnostic-only
token handle rights identified by actual #967/#968 Windows BLOCKED results.
CreateRestrictedToken retains source handle access; lowering/launching its new
token requires ADJUST_DEFAULT/ASSIGN_PRIMARY. No parent token is modified and
no AppContainer/LOW/non-elevation/privilege/group/Job invariant is loosened.

No existing source branch/main is rewritten; this is a Draft child of the exact
six-gate source candidate. No install, enrollment, Windows Hello ceremony,
device/Agent/Broker/service/task/UAC/ACL/VM change, merge or deploy is performed.
