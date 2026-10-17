# Scale v2 S5 — Actual Node Worker-thread SQLite writer contention (DEV ONLY)

**2026-10-17.** Unlike the previous serial/interleaved S5 microbenchmark, this test uses physically parallel **Node.js Worker threads**, with **separate SQLite connections** to one temporary owner database, a shared Atomics barrier and actual write-lock contention. All test traffic stays inside one authorized DEV PC. It is **not** remote TLS/WSS, ChatGPT MCP, Cloudflare Worker or a native tool test.

## Reproduction

`node --test --import tsx test/owner-quota-concurrent-writers-staging.test.ts`

- Driver `test/owner-quota-concurrent-writers-staging.test.ts` creates a temporary filesystem SQLite database and seeds ONE synthetic owner account with **Custom 100 per UTC day** and one Safe-mode device. DB runs `WAL`, `synchronous=FULL`, `busy_timeout=30000`. These are test options only, not a live plan change.
- Workers execute the existing `ProposedTrustedOwnerQuotaAuthority.reserveLogicalTool` implementation, each with its own database connection and synthetic first-party bearer verifier, fixed UTC day and a read-only tool fingerprint. A SharedArrayBuffer/Atomics barrier synchronizes real attempted admissions and triggers SQLite's real lock contention. The only operation is reserving usage; every response must have `authorizesToolExecution:false`.
- Each worker races the **same logical invocation ID** first; then generates unique per-worker IDs. Replay must yield `duplicate`, never consume another credit. At the quota limit, remaining unique attempts must yield `daily-exhausted`, never permit additional usage. DB invocation ledger row count must equal the per-day usage ledger and number of successful unique reservations.
- First scenario: **4 worker threads x 40 unique attempts + 4 same-ID attempts = 164 operations**; exactly **100 accepted**, **3 duplicate**, **61 exhausted**, **100 daily used**, **100 canonical invocation rows**.
- Second scenario: **6 worker threads x 20 unique attempts + 6 same-ID attempts = 126 operations**; exactly **100 accepted**, **5 duplicate**, **21 exhausted**, **100 daily used**.
- Both scenarios finished **PASS** on Work PC. Negative input dimensions are rejected before any temp DB or worker is created. Worker teardown and temp SQLite deletion occur even on failure. Timeout gating ensures this test cannot hang indefinitely; it uses at most 8 workers and bounded work, with no provider calls or persistence.
- This is a **real local SQLite multi-writer correctness test**, not a stable benchmark of committed writes/second, remote user concurrency, or 24h throughput.

## Remaining production NO-GO

1. Concurrent admission must be tested with **real device authentication, revocation, owner WSS/TLS remote network**, and a production-grade operator service, including ambiguous network results, broken connections during SQLite commit and service restart.
2. Measure maximum simultaneous user connections, p95/p99 owner RPC latency, transient `SQLITE_BUSY`, forced DB lock/timeout, WAL checkpoint, durability on power loss and disk full, database growth over many UTC days, encrypted backup and safe recovery.
3. Provider upstream OpenAI Secure MCP Tunnel shared default 600 ingress requests/min, rejected/discovery/retry overhead, actual production hosted routing, Cloudflare request/D1 pricing and measured incremental operator invoice remain independent limits.
4. This does **not** guarantee **850,000 successful native tool executions/day** or zero additional provider cost. A customer's usage allowance is not a minimum completion SLA. User permissions/Safe/Full/Root and native Broker authorization are completely separate from a quota `reserved` response.
5. No live Free/Plus/Pro/Custom plan, billing, new public tunnel, firewall, Agent, Hub, Tailscale, or Cloudflare worker migration is activated. Hosted Free remains **1,000 weighted credits per UTC month**.

**Status: DEV multithreaded contention correctness accepted, production scale NO-GO.**
