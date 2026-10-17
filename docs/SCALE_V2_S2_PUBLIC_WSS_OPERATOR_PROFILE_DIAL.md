# Scale v2 S2 — Operator-enrolled public WSS profile dial (STAGING)

**2026-10-17.** This change builds on the merged public WSS identity PR #525 and signed owner quota integration PR #531. It has no deployment path into the live Native Agent, Hub, Cloudflare or customer OAuth enrollment.

## Implemented boundary

- The existing `ProposedOutboundQuotaWsClient` can now accept a **full operator-provisioned `OwnerPublicWssTrustProfile` object**, in addition to its legacy loopback/private-Tailnet staging arguments. For a public profile the client first validates the **exact `wss://` hostname and owner quota route**, then constructs the WebSocket from that **validated endpoint only** with the hardened HTTPS Agent settings provided by `createOwnerPublicWssClientOptions`.
- Public mode **cannot** be activated by supplying a bare string URL or by combining the public profile with legacy staging TLS options. There is no dial-target override, redirect fallback, user-supplied port, untrusted custom header, TLS1.2 fallback or arbitrary CONNECT proxy in this new code path.
- TLS profile policy remains first-party enrollment controlled. It must **never** be accepted from MCP tool arguments, forwarded request headers, DNS responses or untrusted customer-provided subscription metadata. The profile is not signed or delivered by a real production onboarding implementation in this PR.
- The WSS client now enforces **16 KiB maximum inbound response payload** on both old staging and public modes; malformed/oversized responses fail closed. Original per-connection unique correlation IDs, 16 pending requests, bounded call timeouts, no transparent retry and explicit `authorizesToolExecution:false` owner RPC semantics remain unchanged. The allocated operator HTTPS Agent is destroyed on connection termination/close.
- The client still only **reserves a trusted owner quota**: it never permits a native OS tool, changes entitlements or updates device owner registrations.

## Verification and limitations

`test/owner-public-wss-operator-client-staging.test.ts` confirms caller-selected public URLs, invalid public trust profiles and mixed public/Tailnet trust inputs are rejected **before opening an outbound network connection**. A real loopback WS fixture sends a response over the allowed 16 KiB frame limit and the client rejects it without exposing native execution. The earlier stacked #531 suite uses real TLS1.3 local WSS with public hostname SNI, CA, SPKI and signed owner RPC reservation/replay. **Do not call these tests proof of a deployed public DNS endpoint.**

Next acceptance requires first-party authenticated account/device enrollment and profile issuance, real operator-controlled DNS/TLS ingress, two off-tailnet consumer networks, reliable reconnect/revocation, caller identity proof, actual shared upstream 600/min usage telemetry and measured 24-hour 850k/day load/cost. None of those are activated here.

**Live Free stays at 1,000 weighted monthly credits. Future daily plans/Custom Usage/checkout remain OFF.**
