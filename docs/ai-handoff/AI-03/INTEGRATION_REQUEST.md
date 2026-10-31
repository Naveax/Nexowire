# AI-03 | Minimal cross-owner integration requests (no edits outside AI-03)

## AI-02 | Protected enrollment service
- Provide one-time local owner/admin consent with a durable, revocable per-device v2 grant in protected CNG/TPM custody.
- Expose a **separate** fresh authenticated current-binding readback of SID/session ID/logon LUID/session epoch plus owner/device/installation/enrollment and epoch/generation. Recheck after all async sign/DB operations.
- Define a versioned, cryptographically verified bridge from local v2 ES256 grant/challenge to the existing verifier v1 proof flow; NEVER label v2 signatures as Ed25519, never fabricate `localEnrolled` or `CORE.active`.
- Specify nonce replay storage (atomic one-use durable claim), current revoke/restore witness and grant lifetime versus short-lived network request TTL.

## Coordinator / deployment owner
- Provision production client/server PKI, server SPKI pins, credential resolver, signer keys and recovery/rotation workflow in protected host only. Do not ship secrets or pins in Agent-controlled configuration.
- Handle **coordinated server SPKI pin rotation** via a protected independently authenticated update; old pin must fail closed. A replacement key signed by the same CA is NOT sufficient by itself.
- Compose an actual protected verifier endpoint/Worker-capable authenticated transport; Node mTLS adapter is not a Cloudflare Worker binding.
- Add dedicated CI environment if needed for disposable cert/PG real integration. The `package.json`, workflow and installer files are coordinator-owned; this branch does not edit them.
- Resolve independent restore witness / CAS host and full physical two-PC acceptance with revoke, reboot, offline and session-switch negatives before any CORE GO decision.

## AI-06 | Consumer only
- Consume externally verified current-binding status; do not import test certificates, synthetic ledger, or enable executor from AI-03 results. Keep dispatch disabled without native readback and separate Broker admission.
