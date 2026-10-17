# Scale v2 S2: Operator-signed public WSS enrollment (STAGING)

Isolated code adds a fail-closed verification primitive. It does NOT activate a public WSS ingress or real account/device registration.

- Operator signs deterministic version-1 enrollment bytes with Ed25519. Its private key stays off consumer machines and out of Git.
- An independently pinned operator public key/key ID and independently authenticated account ID, device ID and active session generation are required.
- The signature covers the operator/key/account/device/session, monotonically versioned profile revision, issued/expiry times, exact WSS hostname/route, CA mode/CA roots and SPKI pins.
- Verifier requires exact schemas, a valid Ed25519 signature, max 24-hour credential lifetime, max one-minute issue-time skew and revision no lower than authenticated minimum.
- Returned immutable profile only permits a future WSS dial. It never grants an OS command, changes a user subscription or counts as a quota reservation.
- Tests use an ephemeral key on local staging only; no public endpoint, actual customer account, real device registration, network calls or privileged OS operation.

**PRODUCTION NO-GO:** independent signing-key distribution; real OAuth and possession-bound device onboarding; durable monotonic revision/session storage; key rotation/revocation; renewal/reconnect; public DNS/TLS endpoint and off-tailnet consumer test; Broker policy enforcement and 24-hour capacity/cost measurement. Verifier is NOT connected to the live onboarding path; direct trusted-profile construction remains staging-only.

Hosted Free remains 1,000 monthly weighted credits. New daily plans, Custom Usage, billing and 850k/day throughput guarantees remain OFF.
