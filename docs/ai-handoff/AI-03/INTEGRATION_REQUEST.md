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

## Additional AI-02 / coordinator credential-binding acceptance
- Protected `authenticateVerifier(credential, {certificateSha256}, signal)` implementation MUST reject bearer-token reuse with any other client certificate, **even when that certificate chains to the same trusted CA**. Bind a protected exact fingerprint to owner/device/installation and role, support explicit audited rotation/revocation, and recheck identity after asynchronous custody operations. No client-supplied `X-Forwarded-Client-Cert` or header fingerprint is evidence.
- Independent issuer provenance blocker remains: the v1 request supplies `expected.issuerSpkiSha256`. A SQL handoff row that echoes that value is not proof of independently authenticated local issuer/grant ownership. Require versioned AI-02 v2 ES256 proof readback and verified issuer binding before any physical CORE GO.

## P0 | Protected transport composition required
- Coordinator must wire `RemoteTrustedNativeCoreEnrollmentVerifier` and local protected consent clients to an explicitly injected, authenticated, pinned mTLS-capable transport. `fetchImpl` cannot be left undefined; `CORE_NATIVE_PROTECTED_TRANSPORT_REQUIRED` is intentional fail-closed startup/request behavior. Do not pass ordinary `globalThis.fetch` as a substitute; it does not bind protected client cert/server pin.
- Provide a production/runtime injection proof (real trusted CA, hostname, server SPKI, protected client certificate key and bearer-to-certificate mapping), and ensure no credential is sent when transport provenance is absent. The current tests inject test-only transports; independent deployment validation remains blocked.

## P0 | Independent issuer field in protected native readback (new AI-03 gate)
- For every enrollment `verify-and-consume` / `current-readback`, the protected callback `readProtectedNativeBinding(expected,signal)` must return `issuerSpkiSha256` from separately verified local v2 issuer custody. Missing, mismatching, substituted or rotated issuer fails `CORE_APPROVAL_ISSUER_UNVERIFIED`, before handoff consume or after COMMIT readback. Do not forward caller-supplied `expected.issuerSpkiSha256` as readback; the callback receives only current `CoreApprovalBinding`, not an issuer to echo.
- AI-02 must provide a signed, versioned v2 CNG ES256 local grant and stable protected issuer-key proof to the independent verifier, and define revocation/rollback-resistant readback. This narrowed source gate is not a substitute for independently cryptographic v2-to-v1 bridging and physical test evidence.
