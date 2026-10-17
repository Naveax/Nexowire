# Scale v2 S2 — Real two-PC device-held Ed25519 private-key proof (DEV / STAGING)

**2026-10-17**. This is a second, stronger physical two-PC test following `test/scale-v2-tailnet-wss-two-pc-20261017` and its PR #523. It explicitly closes that test's proof gap: the device signer key was generated on the owner host for the earlier signed-payload round trip. **This time the private device key was generated, held and used only inside Naveax's Python process memory, never sent to the Work PC.**

## Reproducible test harness

- `test/fixtures/scale-v2-tailnet-client-key-naveax.py` runs on the remote Naveax Windows PC using existing `cryptography` and `websocket-client`. Creates **Ed25519PrivateKey.generate()** in volatile process memory, exports only the public SPKI DER as Base64 to the operator for explicit DEV enrollment. No private PEM, seed, seed words or key file is created. The client waits for a one-time temporary owner config, validates TLS 1.3, CA chain, IP SAN and the SHA-256 leaf pin, and signs exact canonical owner-RPC bytes locally with Ed25519.
- `test/fixtures/scale-v2-tailnet-client-key-owner-smoke.ts` runs only on the trusted Work PC. It accepts an explicit operator-supplied **device public DER key** and a pinned existing OS Tailscale interface IP from environment (no literal device Tailnet IP committed), validates the key is Ed25519 public, creates an ephemeral **FAKE** account, bearer, SQLite tables, and 75-second temporary WSS/TLS1.3 owner quota RPC. The owner cannot sign as the Naveax client because it never sees the private key.
- The client computes the owner-RPC protocol canonical request as `SHA256(JSON([bearer, invocationId, toolId]))` within the signed fixed `POST /internal/owner-quota/v1/reserve` envelope with device ID, random nonce, signed timestamp and v1 protocol. It sends the exact original signed request twice with different WebSocket correlation IDs. No command is executed: it is only a **read tool quota reservation** and the RPC always returns `authorizesToolExecution=false`.
- No production enrollment, subscription, token issuance or tool command privilege is exposed. The existing Tailscale/WireGuard private network is used for secure transport; this is **not** customer internet access without private-tailnet membership.

## Actual two-device result

**PASS** on two distinct connected Windows computers:

| Control | Observed result |
|---|---|
| Origin owner host | Work PC, disposable owner-only TLS 1.3 WSS on pinned Tailscale adapter |
| Actual client | Naveax, outbound WebSocket to Work PC |
| Device private key created / retained | Naveax Python process RAM only |
| Key transferred to Work PC | Public Ed25519 SPKI DER only |
| TLS transport | TLSv1.3 |
| Owner certificate check | Trusted DEV CA, IP SAN and SHA-256 leaf pin passed on Naveax |
| New locally-signed device RPC | HTTP 200 / `decision=reserved` |
| Native tool execution grant | `false` |
| Signed nonce replay | HTTP 409 |
| Test cleanup | PASS on both devices |

**Exact read-only result from the remote client:** `{"passed":true,"tls":"TLSv1.3","leafPin":true,"firstStatus":200,"firstDecision":"reserved","executionAuthorized":false,"replayStatus":409,"privateKeyStayedInClientRAM":true}`.

The test's `privateKeyStayedInClientRAM=true` is a property of the reviewed ephemeral Python process and its test sequence, **not** attestation from a TPM or an OS-protected keystore. An actual malicious/completely compromised PC can still access its own key material or modify client code. For production, use an approved system keystore/TPM where available, explicit device onboarding, key rotation/recovery, owner approval and revocation.

After acceptance, Work PC managed server terminated. Work PC test cert/private key/readiness was cleaned and checked `NoSmokeProcess=true, ReadinessRemoved=true, CertDirsRemoved=true`. Naveax temporary source script and fake bearer/config files removed and checked `TemporaryInputRemoved=true, ClientScriptRemoved=true`. The private device key was never written to a file. No Windows firewall, Agent, Hub, Broker, Tailscale Funnel/Serve, Cloudflare, subscriber plan or payment state was mutated.

## Release status

This closes the **basic client-held signer / real two-PC private-network WSS** integration proof. It does **not** solve:

1. Public any-location WSS with stable approved hostname, valid CA, authenticated owner-controlled service and sustainable $0 incremental cloud-provider bill; a common Tailscale tailnet for every paying customer is not a universal solution.
2. Full first-party OAuth, account consent, validated user/device enrollment, key custody/rotation/compromise recovery and immediate revocation including in-flight commands.
3. Official OpenAI Secure MCP Tunnel metadata and its shared provider-default 600 MCP requests/min, counting denied/discovery/failed requests before origin.
4. Real measured 850,000 completed tools per day, 24h soak, owner PC bandwidth/SQLite lock/concurrency, provider rate windows, downtime recovery and zero-cloud-invoice proof.
5. Current live Free-only **1,000 weighted tool credits/month**; proposed daily Free/Plus/Pro and Custom 100–850,000/day stay OFF, billing/checkout OFF. Quota reservation is never permission for OS command execution.

**Status: isolated private-Network S2 proof PASS; production rollout NO-GO.**
