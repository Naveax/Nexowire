# Scale v2 S5 — Bounded owner SQLite quota microbenchmark (DEV ONLY)

**2026-10-17.** A reproducible and intentionally **local-only** capacity measurement of the S2 trusted owner-side **logical tool quota reservation**. It does not hit ChatGPT/OpenAI, Cloudflare, Tailscale, TLS/WSS, MCP Hub, the Native Agent, commercial entitlements or any real tool. It opens no network socket and changes no running production service.

## Method

- New opt-in script: `scripts/bench-s5-owner-quota-local.ts`. CLI: `node --import tsx scripts/bench-s5-owner-quota-local.ts --requests=1000 --accounts=4 --replayChecks=12`.
- Explicit hard cap: **10,000 synthetic reservations per run**, 1–50 synthetic accounts, replay checks 0–100. Malformed/unknown parameters and excessive limits are refused; no network or cloud target option exists.
- Temporary filesystem SQLite, **WAL + synchronous=FULL**, two independent connections to one trusted owner file, interleaved requests (not parallel simultaneous SQLite writers). A static UTC test day, synthetic server first-party authenticator, real owner-DB plan/device/nonce-independent logical invocation quota implementation, and one native `BEGIN IMMEDIATE` transaction per unique tool request.
- Ephemeral tables, fake tokens and account names only. Each admitted invocation ID and amount charged are cross-checked with the daily and immutable invocation ledgers; replayed invocation IDs must return `duplicate` without extra charge. `authorizesToolExecution` must always be `false`. The file/WAL temporary directory is removed after the run.
- Reports p50/p95/p99/max local per-reservation latency, time for unique accepted loop, mean observed completed local reservations/sec, file+WAL bytes and permanent disclaimers. It does **not** report provider/WSS throughput or billable cost.

## One observed Work PC result (single runs, not statistically stable SLA)

| Metric | 1,000 reservation sample | 5,000 reservation sample |
|---|---:|---:|
| Synthetic owner accounts | 4 | 10 |
| Accepted unique logical reservations | 1,000 | 5,000 |
| Failed unique reservations | 0 | 0 |
| Replayed same logical invocation, correctly deduplicated | 12 | 20 |
| Total time for unique loop | 1,364.180 ms | 6,919.453 ms |
| Observed local reservation rate | 733.04/s | 722.60/s |
| Per-reservation p50 | 1.7389 ms | 1.7282 ms |
| Per-reservation p95 | 1.8952 ms | 1.8811 ms |
| Per-reservation p99 | 2.3601 ms | 2.4236 ms |
| Worst single local reservation | 15.0204 ms | 27.6410 ms |
| SQLite main database file during measurement | 262,144 B | 1,110,016 B |
| SQLite WAL during measurement | 4,128,272 B | 4,136,512 B |

**Crucial caution:** The exact values above are **one-time DEV measurements** on the Work PC, not production live metrics, not a stress-tested concurrency ceiling and not an argument for 850,000 actual completed MCP tool calls/day. Some local values depend on OS caching, Windows disk fsync behavior and DB checkpoint timing. Interleaving across two connections is NOT simultaneous request contention. The two sample rates are not a provider transport result; real OAuth, network, TLS, WSS, Relay, native tools and Cloudflare cost may dominate. Likewise 600 requests/minute is a distinct upstream provider-side shared budget and does not become 733/s from SQLite optimization.

## Required next S5 acceptance

1. Verify actual first-party session+device key issuing flow, real WSS remote owner origin, and safe in-flight native tool checks before customer access.
2. Build bounded controlled tests of **simultaneously arriving** requests over two actual devices, with UTC rollover, 409 duplicate/no second OS execution, system clock failure and forced DB lock/commit ambiguity. Distinguish local admission from actual successful native tool effect.
3. Profile SQLite transaction contention, WAL checkpoints, steady-state disk growth, p99, CPU, RAM, connection fan-out, owner PC uptime and its real upload bandwidth across >1 account.
4. Verify actual provider request counting, 600/min global MCP ingress behavior, backoff and 429 cost before promising Custom Usage 850,000/day. **864,000 theoretical requests/day at perfect full-time 600/min leaves almost no room for metadata/retries; it is not an SLA.**
5. Compare real increment to operator Cloudflare request/D1 row cost and bill, under zero-spend guard and explicit approval. **No production migration, paid plan, new daily quota or Cloudflare configuration was activated by this benchmark.**

**Current LIVE Free remains 1,000 weighted credits per month; future daily Free/Plus/Pro and Custom 100–850,000 remain OFF.**
