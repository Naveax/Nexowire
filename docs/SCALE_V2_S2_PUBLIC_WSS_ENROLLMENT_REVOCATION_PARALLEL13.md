# Scale v2 S2: enrollment/revocation follow-up (parallel-13, STAGING ONLY)

This change is **stacked on draft PR #537** and does **not** repeat its public Quick Tunnel two-PC smoke. The #537 physical smoke used synthetic identity and a temporary Cloudflare Quick Tunnel; it is not production acceptance.

## Change and security boundary

- The enrolled outbound quota client rejects a mismatched signed RPC device ID before sending any frame; the owner-side RPC still performs authoritative account/device/nonce/signature checks.
- Before the request, the signed operator enrollment is checked against independently retrieved owner state. After a transport reply (including an HTTP 200), owner state is checked **again** before the result is returned to its caller.
- If the session/device/account/key/revision has changed, the trusted state is unavailable, the transport fails, or the session is explicitly closed, the lease is permanently invalidated and the transport is closed. Uncertain reservations are **never automatically replayed**; reconciliation belongs to the owner-side invocation journal.
- An in-flight request may already have been charged on the owner server before the client discovers revocation. Client post-response gating prevents treating that reply as a valid *client result*, not the physical server action. It does not guarantee instantaneous cancellation at the exact revocation millisecond and grants **no native Broker/tool execution authority**.
- These are incremental protections on a staging adapter, not production key management or an external OAuth implementation.

## Local negative acceptance matrix

| Scenario | Expected outcome |
| --- | --- |
| Same signed device, stable owner state | Successful reply; three independent owner state reads (establish, pre-send, post-reply) |
| Wrong signed RPC device ID vs enrolled device ID | No outbound send, closed session |
| Session generation revoked while reserve is in flight | Late HTTP 200 rejected; session closed and not reusable |
| Owner trusted reader unavailable while reserve in flight | Late HTTP 200 rejected; session closed |
| Session explicitly closed before late reply | Late HTTP 200 rejected |
| Device public key rotated, stale old private key proof | Enrollment issuance denied |
| New rotated key possessing proof | Issuance accepted by staging owner, subject to live owner state |
| Device key disabled/revoked | No new issuance |
| Incorrect trusted operator Ed25519 public key/issuer | Signed enrollment verification denied |

Existing #537 suites additionally cover stale revision, account/device transfer/disable, clock rollback, nonce replay, TLS trust constraints and expiry.

## Protected key storage: explicit production BLOCKER

Staging generated Ed25519 private keys in memory. **No persistent device key storage is deployed by this PR.** A production Windows Agent must generate keys locally and store a non-exportable user/device-bound private key using Windows CNG/TPM (where supported), or a documented equivalent secure keystore. Never commit PKCS#8 PEM, pass a private key through an MCP tool argument, embed it in an enrollment URL, or use the simple in-memory staging fixture as a persistent secret store.

Required production validation: signing works under the authorized Agent identity; another OS account cannot export/use the key; reboot and Agent restart preserve identity; owner transfer and key revocation deny old possession; rotation provisions a distinct key and increases trusted revision; rollback cannot reactivate a revoked key. These operations remain unimplemented/unverified here.

## Named Cloudflare tunnel/operator domain: READ-ONLY preflight gate

Do not provision a named tunnel, route DNS, rotate Cloudflare API tokens or deploy Agent/Hub until the operator separately proves each of these through authenticated, read-only Cloudflare account and DNS evidence:

1. Operator-approved Cloudflare **account ID**, zone ID and zone hostname; authorization to manage that zone.
2. Existing named Tunnel ID, its ownership/account binding, ingress route and Cloudflare Access policy, where used. Absence is a **block**, not implied permission to create one.
3. Public hostname DNS record matches the intended hostname and configured ingress route. Validate independent DNS lookups and a CA-validated TLS 1.3 handshake to the exact hostname; enforce the independently operator-enrolled SPKI pin rather than pinning one discovered over an untrusted connection.
4. Authenticated operator signing key fingerprint and signed, bounded enrollment profile bound to account/device/session; owner-controlled revocation reader is reachable and fails closed.
5. Rate limit, operational cost and credential-rotation/incident response review, plus off-LAN external-network tests and in-flight server-side Broker grant revocation.

No account, zone, tunnel ID, DNS state, independent ISP, DPAPI/CNG/TPM protection, customer OAuth issuer or real Broker authorization was verified by parallel-13. Production deployment status is therefore **NO-GO**.

## Validation / containment

- Tests require no public network listener, Cloudflare provisioning, real device enrollment, production token or Agent restart.
- Test Ed25519 keypairs and synthetic bearer strings exist only in the test process. They are not saved to disk as private-key artifacts.
- Parent PR #537's previous Quick Tunnel cleanup remains as documented there. Parallel-13 started **no new Quick Tunnel**.
- Do not claim a named public Tunnel, production rollout, native grants or real persistent keystore based on these tests.
