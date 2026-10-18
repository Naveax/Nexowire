# Scale v2 S5 | Load, fairness, cost and capacity acceptance (2026-10-18)

**Issue:** [#487](https://github.com/Naveax/Nexowire/issues/487), parent [#482](https://github.com/Naveax/Nexowire/issues/482).
**Release decision: PRODUCTION NO-GO.** This is *synthetic DEV fixture acceptance only*; NOT 24-hour staging, cloud-provider billing verification, 850k successful tool invocations, or a change to live Free plan. Branch `test/parallel-15-scale-load-cost-20261018` based on `a54cbbd37e981a169631d688b53c7e3b3e90f48`. Verify PR head SHA separately.

## Evidence and interpretation

- `scripts/bench-s5-loopback-ws-capacity.ts`: real **127.0.0.1 plain WebSocket TCP sockets** and packet transport, genuine proposed owner SQLite admission and 600/min local transport meter. Synthetic static UTC clock, test-only bearer verifier, one local SQLite writer. Max **256 sockets**, 1–4 RPC/client, 16 server-side logical in-flight, queue 256, 32 active RPC-generating clients. No external hostname/endpoint argument. Closes sockets and removes temporary WAL database in a finally block. No native tool dispatch. Latency includes loopback+auth stub+SQLite; not hosted provider or native-tool latency.
- `test/s5-loopback-ws-capacity.test.ts`: **16/32/64/100/256** client connection and reservation scenarios, equal-user fairness, replay, multi-account isolation, shared-account exhaustion, pressure-induced queue rejection, and unsafe-option denial. Original 256 simultaneous-dial/ungated burst exhibited local ECONNREFUSED/RPC timeout; bounded 16-connection handshake batches and 32 active client RPC streams proved that retry storm is NOT safe. The limit is a fixture bound, not a staged scale claim.
- Existing `test/owner-quota-concurrent-writers-staging.test.ts`: independent genuine multithreaded SQLite writer contention and one logical invocation replay; it checks a 100/day local limit, **not provider-wide 600/min concurrent enforcement**. The S5 additional rolling-minute boundary test exercises 600 admitted then 12 denied via a single local writer and synthetic clock. It does not test a 600/min remote provider limit.
- `scripts/report-s5-measured-scenarios.ts`: writes an immutable-on-create machine-readable local output at `docs/reports/s5-local-synthetic-20261018.json` with exact source SHA, host info, real active/peak socket count, queue depth, CPU user/system, RSS samples, SQLite/WAL and packet byte counts, p50/p95/p99/max, replay, 429 and per-client Jain fairness. This report is *measured local*, cost matrix inside is labeled *assumed*. Reproducing on another host requires a new independent report; do not edit an old measurement and call it original.
- `src/ops/scale-s5-cost-envelope.ts` and `scripts/report-s5-cost-matrix.ts`: conservative **assumption-driven** free envelope and paid partial-cost estimate. No Cloudflare usage API was called, no account invoice inspected, no egress/DO/TURN expenses inferred.
- `scripts/s5-soak-local-runner.ts`: explicitly acknowledged (over five minutes) bounded synthetic loopback sampler, at most 32 clients and 1,440 minutes, stopping on an error. Recreates its database each minute and **does not establish persistent staging/WSS/ledger continuity**. It cannot count as a completed 24h acceptance soak.
- `scripts/s5-soak-acceptance.ts`: *fail-closed evidence gate* requiring at least 24 actual hours, minute samples with no >2-minute gaps, exact source SHA, real completed-tool and provider counters, owner approval, and no incident. It checks submitted metadata, not signed provider attestations. Operational acceptance additionally requires independent evidence audit and SLO signoff.

### Measured Work PC loopback sample (source `ec5248d5998b66faf7429e116f94c3d26bcd5841`)

| Open WebSockets | Unique quota reservations | RPC p99 | Whole-run wall time | Jain equal-load index |
| ---: | ---: | ---: | ---: | ---: |
| 16 | 32 | 117.742 ms | 361.47 ms | 1.00000 |
| 32 | 64 | 542.159 ms | 1,669.17 ms | 1.00000 |
| 64 | 128 | 1,104.188 ms | 4,290.62 ms | 1.00000 |
| 100 | 200 | 610.757 ms | 5,545.78 ms | 1.00000 |
| 256 | 512 | 887.978 ms | 16,614.29 ms | 1.00000 |

Single run per population; samples are subject to Work PC foreground activity, Windows scheduling, storage cache and Antivirus. No stable SLA confidence intervals. Connection counts are local TCP WebSocket connections; open WSS staging sessions, completed OS tool tasks and cloud requests: **not measured**. For CPU/RSS, actual bytes, socket teardown, latency p50/p95/p99/max, queue and replays, inspect the full machine-readable JSON source record.

### Reproduction

From the isolated worktree with Node >=22 and dependencies installed:

```powershell
npm run typecheck
node --test --import tsx test/s5-loopback-ws-capacity.test.ts test/scale-s5-cost-envelope.test.ts test/s5-soak-acceptance.test.ts
node --test --import tsx test/owner-quota-concurrent-writers-staging.test.ts
node --import tsx scripts/bench-s5-loopback-ws-capacity.ts --clients=100 --mode=isolated
node --import tsx scripts/report-s5-cost-matrix.ts
node --import tsx scripts/report-s5-measured-scenarios.ts
# Intentionally NOT executed: 24h local sampler or any actual staging load.
# node --import tsx scripts/s5-soak-local-runner.ts --minutes=1440 --clients=16 --ack-long-running
```

The JSON under `docs/reports/` is the immutable record for this exact Work PC run. Every result has `ledger.toolExecutions=0`. It must not be relabeled actual application throughput. A 256-connection localhost fixture does not remove the previously observed **16-session staging owner WebSocket limit**.

## Capacity and cost model

All values below are **deliberate, replaceable assumptions**, not measured Worker/D1 usage: 2 Worker ingress requests per hosted logical call, 4 additional control requests per user/day, 1 socket upgrade per user/day, 5% additional HTTP ingress retry load, 4 D1 rows read + 2 written per logical call, 1 ms Worker CPU per HTTP request, 10 KiB payload per logical call, 30% relayed share, 30 days/month. The 2-ingress route is a repository-documented historical path, not guaranteed for all current transports; after S1 auth/charge fusion, measure actual fan-out instead of forcing 2.

```
daily_calls = active_users * calls_per_user_daily
daily_worker = ceil((daily_calls * worker_requests_per_call +
                     active_users * control_requests_per_user_daily +
                     ws_upgrade_connections) * (1 + retry_fraction))
daily_d1_reads = daily_calls * rows_read_per_call
daily_d1_writes = daily_calls * rows_written_per_call
daily_relay_GiB = daily_calls * bytes_per_call * relay_fraction / 2^30
```

| Modeled load | Calls/day | Worker requests/day | D1 writes/day | Fits *numeric* Worker+D1 Free envelopes? |
| --- | ---: | ---: | ---: | --- |
| 100 active, mixed utilization 205/day | 20,500 | 43,575 | 41,000 | Yes, **conditional** |
| 1,000 active, mixed 205/day | 205,000 | 435,750 | 410,000 | **No** |
| 10,000 active, mixed 205/day | 2,050,000 | 4,357,500 | 4,100,000 | **No** |
| 100 active, planned Free full 1,000/day | 100,000 | 210,525 | 200,000 | **No** |
| One Custom at 850,000/day | 850,000 | 1,785,006 | 1,700,000 | **No** |

These are hypothetical **future** utilization scenarios. Current LIVE Free remains **1,000 weighted units per UTC MONTH**; do not migrate to daily or enable subscription/billing from this branch. In the model, 100 users at 205 calls/day fit request/row Free thresholds; **zero incremental operator bill is NOT proven**, because the free account state, peak per-invocation CPU, D1 storage, provider usage, DO, WSS topology, ISP/egress, tunnel plan and all other billed services remain unverified. A numeric free fit is a *necessary*, not *sufficient*, condition.

**Published Cloudflare anchors, checked 2026-10-18:**

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free 100,000 requests/day, 10 ms CPU/invocation, 128 MB memory/isolate.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): standard paid $5/mo floor, 10 million included requests/mo then $0.30/million; 30 million CPU-ms included/mo then $0.02/million. A Worker WebSocket initial Upgrade counts as an HTTP request; subsequent frames handled on that socket are *not* identical to new Worker HTTP ingress invocations.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free 5M rows read/day, 100k rows written/day, 5GB storage; Paid included 25B reads/mo and 50M writes/mo then published unit rates. D1 doesn't charge transfer egress separately, but that does not imply all network egress is free.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): distinct request/message/duration/storage meter; WebSocket hibernation matters. *Not included in this partial bill*. [Hibernation guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- ISP upstream bandwidth, any TURN relay, specialized tunnel product, billing round-up, taxes, paid providers, D1 storage overage and direct WSS service topology **cannot be priced without deployment and meter data**. Don't convert unknown into $0.

At a global 600 admitted requests/minute, an absolute theoretical day is **864,000**. **850,000 requests/day requires 98.3796% continuous utilization** and leaves only 14,000 ingress requests/day for all other competing activity if they share that one provider budget. Its average is 590.28 requests/min for a full 24h. A shared 600/min transport budget and individual daily entitlement are separate ceilings; attempts denied at transport do not become successful logical reservations.

## Fairness, backpressure, fail-closed acceptance

- Equal per-client load with isolated mock accounts makes Jain fairness trivially near 1; this is a fixture consistency check, **not proof against a malicious or noisy tenant**. Real staging requires skewed 95/5 traffic across independent identities, per-account fair queueing, per-device caps and no cross-tenant leaks.
- Record connection open/close, active in-flight RPC, queued work, rejected admission reason, idempotent replay rate, hourly/minutely p50/p95/p99 latency, CPU%, RSS high water, disk/WAL bytes/sec, D1 rows per invocation and billing metadata. Metrics must not carry bearer tokens, URLs, IDs, request content or personal data. Observe actual provider dashboard counters, not just code-calculated counts.
- At pressure, reject safely with a bounded retry-after, never increase worker quotas on errors or replay a mutating operation when outcome is unknown. On SQLite lock, disk full, D1 exhaustion, lease expiry or 429: **deny**, account for observed traffic, keep the last proven reservation state, and require explicit reconciliation.
- Proposed **review thresholds, not approved production SLOs**: 24h coverage, every minute accounted; p99 <=2,000 ms for admitted owner-control RPCs, server 5xx <0.5%, zero double-billed replay, zero cross-tenant usage, no unknown-cost paid egress, sustainable CPU <80% for dedicated staging process and RSS growth <25% after warm-up. Measure during canary with owner actively using their PC; require explicit SLO agreement before treating them as contract.
- Canary only after S1–S4 signed authority, entitlement and revocation: 16 then 32, 64, 100, 250+ **on an explicitly authorized staging address**, increasing one dimension at a time. Maintain connection and actual completed tool counters, verify DNS/outage/reconnect and rolling 600/min races on a shared atomic writer. Stop/revert on hard-budget exhaustion, persistent p99 regression, unauthorized execute, DB divergence, unexpected provider charge or live Agent disconnection.
- Rollback should disable the new staging route/feature flag, preserve old Free weighted-credit policy, capture immutable evidence and compare original SHA; no DNS cutover, paid Cloudflare activation, production quota switch or Agent restart is authorized here.

## Missing release evidence (blocking)

1. No explicitly approved external staging endpoint or cost-meter access was available to this worker; **NO authorized staging load** (16/32/64/100/250+) was run.
2. No 24h persistent hosted WSS load (workstation actively used), independently authenticated users, real OAuth/session/device revocation, WSS hostname verification or native completion evidence.
3. No actual Cloudflare Workers/D1/DO/egress invoices or dashboard metrics, no real ingress-per-MCP-call ratio, no billing hard-stop test.
4. Shared upstream 600/min provider rate race and 850k/day end-to-end completion at sustainable p99 are NOT proven.
5. Failure-injection staging tests (DNS loss, retry, network split, secret rotation, exhausted lease, isolated noisy tenant, relay cap and rollback) must pass; source-only test success is not a release green light.

**Acceptance today:** repeatable synthetic harness + conservative cost model + 24h evidence gate: REVIEWABLE. **Commercial/prod staging acceptance: BLOCKED.** No production changes or user-billed resources made.
