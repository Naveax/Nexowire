# Scale v2 | All-Ingress Shared MCP Transport Budget (S2 / Z2, DEV ONLY)

**2026-10-16.** Independent of the live Nexowire subscription plan, and stacked only on verified main after checkout PR #513 (main `b5dfb9c34dbe05c8620c3b778ba725704253e9c6`). **STAGING/INJECTED HOOK ONLY**: nothing deploys a public MCP server, starts another Agent, turns on billing, upgrades Cloudflare, migrates production D1 or changes any existing Hub/Tailscale routing. The current Free plan remains **1,000 weighted credits/month** (normal tool 1, special skills 5); future Free 1,000/day, Plus 5,000/day, Pro 10,000/day and Custom 100–850,000/day are still OFF.

## Grounded provider contract

OpenAI's official Secure MCP Tunnel docs list **600 MCP requests/minute**, shared by **(tunnel ID, calling app ID)** across channels. If app ID is unavailable the scope is **(tunnel ID, user)**; adding another `tunnel-client` process does NOT multiply that allowance. Also: 10 MiB serialized envelopes, a 120s absolute request deadline, and up to 1,000 pending requests/tunnel. Platform help/permissions and other transports are independent. Provider may throttle before a request ever reaches our origin; our own 429 **cannot refund or alter provider usage**. Do not market a 600/minute guarantee of successful tools or a capability of every ChatGPT Plus account.

Source: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Proposed local-first behavior (code implemented in this PR)

- `src/mcp/all-ingress-transport-meter-proposal.ts`: **trusted owner-hosted SQLite** rolling 60-second admission ledger. Every arrival increments persistent `observed`, including unauthorized POSTs, metadata/discovery GETs, malformed route attempts, client retries and locally rate-rejected attempts. `admitted` vs `rejected` are tallied separately. A 600th admission is accepted and 601st denied; the local limit can be **stricter than 600**, never configured higher. The oldest accepted request expires only after 60s, independent from calendar minute/UTC midnight. Retry-After is calculated from the next eligible timestamp.
- `test/fixtures/scale-v2-all-ingress-transport-staging.sql`: SQLite transaction and counters. `BEGIN IMMEDIATE` creates one-writer serialization on the **same owner-controlled DB**: no duplicate distributed admission on one DB, and no entitlement if the DB or trusted clock fails. Rows from old admitted request windows are pruned only within the same authenticated transport scope; monotonic aggregate arrival totals remain. Multi-host operation requires a **shared trusted remote ledger**; local customer-controlled SQLite cannot enforce subscription limits against a malicious device owner.
- **Optional integration into existing `src/mcp/local-first-ingress.ts`** using programmatic `stagingTransportBudget` injected at server construction. The hook runs before HTTP routing, Host/Origin checks, Authorization verification, upstream forwarding and WebSocket rejection, and returns HTTP 429 with Retry-After or fails closed with 503 when meter unavailable. WebSocket upgrade attempts are also observed and destroyed, never forwarded. The normal `nexowire local-first ingress` CLI **does not set the hook**, so deployed/runtime user behavior remains unchanged and the unauthenticated local Hub is not suddenly public.
- The trusted scope is **supplied by operator-side routing/verified tunnel metadata, never request-supplied `Host`, `Origin`, `X-Tunnel-ID`, user-provided tool JSON or `Authorization`**. Client-supplied fake header scope changes do not create a second bucket. One shared scope covers every user/agent executing on the same authenticated tunnel+calling app pairing.
- This is ingress *forwarding admission*, not an authorized tool execution, account entitlement, OAuth permission, or purchase approval. A request that passes rate limiting but fails authentication still uses one local ingress slot and **does not** consume a successful tool entitlement. A request refused at OpenAI's tunnel never arrives here and is absent from our measured totals. User-facing metrics must not claim provider-synchronized figures.

## Test acceptance

`node --test --import tsx test/all-ingress-transport-meter-staging.test.ts`: **16/16 PASS**:
1. Reject budgets >600 and nonsensical values; allow stricter operator budgets.
2. 600 admitted / 601 rejected, including aggregate counters, with exact 60s boundary recovery.
3. UTC midnight does not reset rolling limiter.
4. Duplicate/discovery/unauthorized arrivals count; no per-user multiplication of one tunnel capacity.
5. Same DB multiple meter objects cannot bypass budget; independent truly verified transport scope permitted.
6. Independent SQLite connections sharing an owner-side durable file cannot both admit the same single slot; invalid sender-supplied scope, trusted clock rollback or missing DB refuse.
7. Real localhost mock HTTP ingress covers missing bearer, OAuth protected-resource GET, forbidden admin path, authorized MCP POST and 429+Retry-After.
8. Forged forwarded-tunnel headers cannot reset bucket, while missing DB returns HTTP 503 without contacting Hub.
9. Staging optional hook survives validated options and counts rejected upgrade; normal no-hook ingress continues unchanged.

**All 16 tests** run against local in-memory SQLite and mock loopback HTTP Hub. No OpenAI hosted tunnel, external ChatGPT connector, cellular network, production D1, or actual 600/min sustained external traffic tested.

## Release gates and limitations

- **Provider-side rate is upstream of our origin.** Instrument `tunnel-client` health and provider-reported quotas, use outbound pacing/cooperative client backpressure where supported; local 429s can't prevent a malicious/disconnected client from issuing provider-counted requests. Never bypass provider quotas via tunnel/client multiplication.
- Securely bind a **real provider-verified** tunnel ID+caller-app/user into this server-internal scope, not an HTTP header. Under no conditions may a user edit a quota SQLite file stored on their PC to raise SaaS entitlement.
- Count all MCP requests across **every** mapped transport ingress (some calls can bypass this local proxy); duplicated scope counters across multiple PCs with separate DBs are NOT globally atomic. Integrate with a trusted owner-hosted admission system on hardware the project already owns, and prove no new operator cloud bills and no network bottleneck.
- Existing Custom Usage proposal PR #511 also has a 600/min admitted-*tool* guard; these are **two separate staging ledgers**. Future integration must define exactly one canonical transport guard plus the separate authenticated daily logical tool quota, with no double-charge or bypass, and account-specific fairness.
- Customer-owned PC has real CPU/IO, bandwidth and concurrency limits. 850,000 logical tool calls/day is a **configurable ceiling**, not guaranteed throughput. It requires 590.3 req/min average and is only 14,000 below an ideal 864,000/day provider rate cap; metadata/auth/retries consume the same provider limit.
- Require end-to-end tests with actual ChatGPT workspace/custom MCP permission, Secure MCP Tunnel / named outbound TLS tunnel, valid first-party OAuth+device owner checks, provider request metadata, 120s request deadlines, 10 MiB payload size, 1,000 pending request ceiling, reconnect, service restarts/rollback and data protection. No public hostname or payment until owner-authorized acceptance.
- The tests do **not** authorize production rollout, new paid subscription promises, or a claim of unlimited free capacity.
