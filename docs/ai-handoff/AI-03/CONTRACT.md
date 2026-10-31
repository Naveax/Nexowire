# AI-03 | Independent native verifier and pinned mTLS contract

## Scope and trust boundaries
- Review baseline: PR #982 HEAD `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39`, which contains #981 host and #970 ledger/handler; verified by GitHub ancestry comparison.
- `createCoreNativeVerifierServer` is an **unbound** Node TLS1.3-only HTTPS server. Composition/hosting, server cert and key, client CA, bounded host configuration and the protected request handler are explicit inputs. It must not create a listener or claim owner approval.
- `createCoreNativeMtlsFetch` is a Node HTTPS adapter, not a Worker transport. It requires deployment-provisioned client key/cert, trusted server CA and exact server SPKI SHA-256 pin. Only `POST /v1/core-native-consent` to an exact HTTPS origin is accepted. Hostname/CA and SPKI checks are conjunctive. No redirect, retry, cleartext fallback or environment proxy.
- The adapter returns a JSON response **only after** an HTTP 200 with exactly one `Content-Type: application/json` (optional UTF-8 charset) and at most one identity `Content-Encoding`. A missing, ambiguous, non-JSON or compressed response has UNKNOWN outcome. It must never synthesize `application/json` for an unverified upstream header.
- Authentication comprises real verified TLS client certificate, certificate-bound protected bearer resolver, explicit `independent-enrollment-verifier` principal, and owner/device/installation binding. HTTP-supplied peer fingerprints do not count.
- Every `verify-and-consume` and `current-readback` verifies request nonce, complete scope including enrollment/epochs/Windows SID/session/LUID/session epoch, signed response request SHA-256, signer pin and response time. Ledger consume is durable/unique; readback revalidates current native and restore witnesses.
- The verifier signer uses independently pinned Ed25519 SPKI on v1 response. No local CNG ES256 grant, software fixture key, test CA, or ledger row is by itself a physical approval.

## AI-02 protected enrollment interface handoff
AI-02 must export a versioned protected **current-binding readback** with: `ownerAccountId`, `deviceId`, `installationId`, `enrollmentId`, `ownerEpoch`, `grantGeneration`, `revokeEpoch`, `windowsSessionId`, `windowsUserSid`, `windowsLogonLuid`, `windowsLogonSessionEpoch`, monotonic trusted observation and revocation/current-owner provenance. The signed durable one-time local grant is separate from the fresh live-session proof. It cannot be taken from a user-supplied JSON flag.

AI-02 must provide explicitly authenticated, per-device provisioning for the independent verifier's certificate-bound credential and protected device key, plus a revocable single-use challenge/nonce claim with durable commit. A v2 machine CNG ES256 signature is **not** interchangeable with the v1 Ed25519 verifier signature: a separately reviewed versioned bridging ceremony and verifier-side validation are mandatory.

## Rotation and expiry
A newly issued server certificate with a different SPKI requires an explicit, independently authenticated new pin. An old pin must reject the new certificate **before** authorization or DB access; never silently fetch or trust a replacement pin from the response. The disposable test cert may expire within hours and is not a provisioning scheme. Rotation of the signer/client CA, credential and revoke epochs is an operator/protected-service responsibility and must fail closed until both ends are coherently re-provisioned.

No code in this PR authorizes dispatch, sets CORE active, provisions production credentials, installs a service, touches live devices or modifies the Worker.

## Certificate-bound principal acceptance (source-only)
- TLS CA verification only establishes that a client certificate was issued by a trusted CA. A separate protected resolver MUST bind the *exact observed* peer certificate SHA-256 to the same credential, owner, device, installation and `independent-enrollment-verifier` role. A different valid certificate from the same CA using a copied bearer must be denied before any ledger read or consume.
- TLS server expiry is checked by the HTTPS client independently of the explicit SPKI pin: a matching pin MUST NOT override validity dates, hostname verification, or the CA chain. A rotated/replaced client cert requires an independently authenticated protected mapping update, never header-provided identity or an Agent setting.
- The new fixture pins a disposable client certificate fingerprint in its resolver to exercise the contract. It does not implement a production credential resolver or establish physical owner consent.

## Explicit protected transport dependency (source-only)
- `callProtectedCoreNativeAuthority` now requires an injected `fetchImpl`. Missing injection fails **before any request** with `CORE_NATIVE_PROTECTED_TRANSPORT_REQUIRED`; it cannot silently fall back to the process-global `fetch` and risk exposing protected bearer credentials over ordinary HTTPS.
- In production the deployment owner MUST inject the exact, separately provisioned `createCoreNativeMtlsFetch` adapter (or independently reviewed equivalent with real client certificate, CA/hostname check, pinned server SPKI, no redirect/retry). An arbitrary injected fetch or test mock does not establish this custody. Cloudflare Worker requires its own separately verified protected transport and composition; no automatic Worker wiring is introduced.
- The common authority caller now rejects ambiguous, duplicated, substring-matching and wrong-charset `Content-Type`, plus compressed/nonidentity `Content-Encoding`, in addition to the stricter mTLS adapter's own checks. Signed payload validation remains mandatory and separate.

## Exact HTTP acknowledgement
- The common protected authority caller accepts only **HTTP 200**. Other 2xx statuses (201 Created, 202 Accepted, 206 Partial Content) are terminal `CORE_NATIVE_AUTHORITY_UNAVAILABLE`, even when their JSON body carries a syntactically valid signed response. This matches the concrete mTLS adapter's existing 200-only rule and avoids treating partial/async responses as final enrollment or readback authorization.
