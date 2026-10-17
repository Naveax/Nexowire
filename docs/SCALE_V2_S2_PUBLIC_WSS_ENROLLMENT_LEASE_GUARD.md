# Scale v2 S2: Recheck signed enrollment before every WSS reservation (STAGING)

This isolated change builds on the operator-signed WSS enrollment verifier (PR #534). It does not activate live Agent, Hub, Broker, OAuth, Cloudflare, DNS, paid plans or customer entitlements.

## Implemented trust boundary

- Before opening a public WSS socket, first verify the Ed25519-signed enrollment against an independently authenticated operator key, account/device owner, current session generation, minimum profile revision and trusted time.
- Keep an immutable snapshot of the signed envelope and verified TLS/CA/SPKI profile. Caller mutation cannot change the existing enrollment's endpoint.
- Before EVERY owner-quota reservation, obtain independently authenticated **fresh** control-plane state and revalidate the enrolled identity. Expiry, key rotation, device revocation, changed session generation, increased revision floor and unreadable trusted state fail closed and invalidate the lease permanently.
- The staging session adapter closes the WSS connection on a failing preflight. No implicit mutating operation replay or automatic re-enrollment. A new connection requires a fresh authenticated enrollment.
- IMPORTANT: Revocation observed by the client cannot retroactively cancel an already in-flight request. The authoritative quota owner and native Broker must separately check session/device/command authorization on every operation. This client guard alone is not a production revocation system.
- The reader callback MUST NOT use profile/header/tool fields as its source of identity. A real trusted authenticated control plane with bounded read timeout is not implemented by this PR. A cached stale reader would undermine revocation.

## Validation and limits

Tests use ephemeral local Ed25519 signing material, synthetic control-plane state and no network listener. The positive public-WSS TLS handshake remains covered by the earlier localhost TLS1.3 suite. No real public endpoint is configured or dialed by this suite.

Remaining production blockers: real first-party OAuth/account/device enrollment, secure device private-key provisioning, authenticated revocation authority, monotonic revision floor, operator signing key rollout and rotation, an authenticated bounded-time state reader, public DNS/TLS ingress, off-tailnet two-PC acceptance, audited native command permissions, upstream provider limits and capacity/cost proof.

Live Free remains at 1,000 monthly weighted credits; future daily plans, Custom Usage and paid checkout stay disabled. No 850k/day success guarantee.
