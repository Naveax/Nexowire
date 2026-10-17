# Scale v2 S2 — Owner RPC response schema fail-closed guard (DEV/STAGING only)

**2026-10-17.** The existing loopback/outbound owner quota WebSocket bridge must not interpret an upstream HTTP **200** status as a sufficient or authoritative quota admission response. It now validates the exact six-field canonical trusted owner `decision` before relaying that 200 to a WebSocket caller.

The checked decision has exact keys `status`, `dayUtc`, `dailyLimit`, `used`, `remaining`, `authorizesToolExecution`. Status belongs to the existing owner authority's allowlist; `dayUtc` uses a canonical YYYY-MM-DD shape, numeric counters are nonnegative safe integers, `remaining = max(0, dailyLimit - used)`, and **`authorizesToolExecution === false`** must hold. Extra/missing fields, a fake command grant, invalid counters, unknown status or missing decision on HTTP 200 are **converted to 502 `owner_rpc_invalid_decision`** and are never represented as an admitted quota decision.

**All native tool authorization remains independent of the quota result.** Existing error statuses, including 409 nonce replay, 401 unauthenticated device, 429 budget and 503 backend unavailable, retain their distinctive error codes and do not turn into acceptance.

## Automated tests

`test/owner-quota-rpc-response-guard-staging.test.ts` exercises the actual loopback WebSocket server and the production-shaped `ProposedOutboundQuotaWsClient` with a **synthetic local HTTP fetch stub**. It tests malformed 200 bodies (including a spoofed `authorizesToolExecution:true`), legitimate six-field owner decisions and non-200 error passthrough. No real first-party bearer, Ed25519 private key, command execution, customer, Cloudflare, Tailscale, DNS or publicly exposed listener is involved. Existing signed owner RPC tests separately validate actual Ed25519 proof and nonce behavior.

This is a **defense-in-depth staging transport hardening**, not a deployed or complete public-WSS client. A valid quota decision does not prove that the OS command succeeded, nor does an HTTP error prove that an ambiguous database transaction was rolled back. Never automatically replay a mutating native action following an uncertain transport result.

**Production remains unchanged:** current Free = 1,000 weighted credits per UTC month, proposed daily Free/Plus/Pro and Custom 100–850,000/day OFF, paid billing OFF, no Cloudflare migration, public WSS endpoint, firewall rule or Agent/Hub/Broker restart.
