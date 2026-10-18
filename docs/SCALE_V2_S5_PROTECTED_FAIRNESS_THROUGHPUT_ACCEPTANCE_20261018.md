# Scale v2 S5: protected user shares, observable throughput and bounded reconnect acceptance

Tracking: [#487](https://github.com/Naveax/Nexowire/issues/487), [#482](https://github.com/Naveax/Nexowire/issues/482), [DRAFT PR #564](https://github.com/Naveax/Nexowire/pull/564).

**Date 2026-10-18. Release decision: PRODUCTION NO-GO.** No actual hosted 24h soak, independently authenticated WSS sessions, Cloudflare account metrics, invoice receipts or native tool-completion proof obtained. Previous Work PC benchmark is not overwritten. The original 16-session staging owner WSS cap is not raised or tested live.

## 1. What changed and what was actually demonstrated

| Evidence / protocol | Implemented / checked | NOT demonstrated |
| --- | --- | --- |
| Global minute budget | Existing proposed shared SQLite meter can let noisy tenant A consume 600 admitted slots first and starve quiet B's 20 requests | Provider-side OpenAI / MCP upstream enforcement |
| Proposed protected shares | New **STAGING ONLY** trusted-policy allocator, SQLite `BEGIN IMMEDIATE`; strict, immutable policy checksum, idempotent invocation fingerprint | Live authenticated identity/plan authorization or Cloudflare/D1 multi-region atomicity |
| Equal A/B config | 600/min divided 300/300; A's 600 attempts yield **300 reservations + 300 denies**, B's later 20 yield 20 reservations | Noisy tenant cannot already consume upstream/provider counted ingress |
| Weighted A/B config | Operator 95:5 weights yield 570/30; noisy A's 620 attempts cannot use B's 30 protected slots | Negotiated production plan weights, preemption, borrowable capacity |
| True SQLite contention | 4 native Node Worker threads, independent connections, 100/min shared config: A attempts 120, B 40, durable totals **A 50 / B 40 / 70 denied** | Distributed Worker/D1 CAS, DO, regional replicas or paid billing |
| Policy integrity | Mismatched operator policy SHA rejected, wrong scope/tenant, different payload same invocation, replay, UTC window rollback and SQLITE_BUSY fail closed | Production signed lease revocation and cross-instance configuration propagation |
| WebSocket reconnect/backpressure | `127.0.0.1` real TCP/WS sockets, 120 logical clients × 3 churn rounds, local queue backpressure and p50/p95/p99 timer | WSS/TLS/cloud path, actual 100+ simultaneous authenticated production sessions, 24h persistence |
| Reservation vs tool completion | Explicit source-labeled counter reconciliation and **zero verified native effects** for all fixtures | A real OS tool effect simply because the quota ledger charged, or a user supplied a completion count |

### Strict-share tradeoff

The 300/300 scheme deliberately **does not lend an idle tenant's reserved half** to the noisy tenant. If B is inactive, only A's 300 requests/min can be admitted even when the global budget could take 600. It prevents starvation but reduces aggregate throughput. A production policy must select a trustworthy fair-queue/lease mechanism with late-arrival guarantees, safe reclaim of unused capacity, plan weights and revocation, and it must be applied **before** provider-side upstream rate accounting where possible. A local per-tenant meter placed *after* an upstream 429 cannot restore already-consumed provider ingress.

The proposed strict-share code is confined to `src/ops/scale-s5-protected-admission.ts`, its DEV SQL fixture and tests. It is not imported by the live Hub, Worker, billing, OAuth, Agent or Broker. Tenant weights and transport scopes are injected from an operator-controlled *test* configuration, never from a request. Cross-process policy hash mismatch requires explicit versioned/guarded reconfiguration; source test coverage is NOT approval to roll out that reconfiguration.

### Capacity and performance measurement contract

Record `ws.connections_opened`, `ws.current`, `ws.peak`, `reconnect.attempted`, `rpc.in_flight`, `queue.depth`, `queue.rejected`, `latency_ms.p50/p95/p99`, `tenant.reserve_denied`, `token.replay_conflict`, `cpu.percent`, `rss.bytes`, `wal.bytes`, `network.egress_bytes`, plus an independent **native tool completion receipt**. Count billing ingress **including** handshakes, discovery, retries and failed auth; avoid mistaking all WebSocket frames for new Worker HTTP requests.

Under the existing harness, 256 local plain-WebSocket connections and local SQLite reservations had already been demonstrated; that is not equivalent to 256 simultaneous authenticated TLS WebSocket connections behind a cloud service. The reconnect fixture admits at most 12 **newly dialed** sockets per batch, though server-side close lag can temporarily raise simultaneous open count. It therefore measures a 120-client population reconnecting in bounded bursts, not an instantaneous 120-connection handshake flood.

## 2. Cloudflare counters, evidence provenance and cost boundaries

`src/ops/scale-s5-resource-reconciliation.ts` separates these quantities:

- `quotaReservations`: successful logical reservation events, **not** native tool effects.
- `nativeCompletedReported`, `nativeFailedReported`, `nativeUnknownReported`: independent reported outcomes. All remain **unverified** until trusted Agent journal plus separately validated result artifact/hash/owner/device/epoch evidence exists.
- `workerHttpRequests`: all billable Worker ingress (not equal to logical reservations); `d1RowsRead` / `d1RowsWritten`: actual SQL engine row counts when obtained from trusted D1 metadata/export.
- `durableObjectRequestUnits` / `durableObjectDurationGbSeconds`: DO message/request and duration ledger, only applicable if real deployment routes through DO.
- `relayEgressBytes`, `wssPeakConnections`, `reconnects`, `rssPeakBytes`, `cpuMeanPercent`: operational indicators, not cost or verified tool-completion evidence by themselves.

The reconciliation returns a **source label** (`synthetic-fixture` vs `operator-unverified-export`), reservation/s, reported completion/s, request-per-reservation and worker-request-per-reported-completion ratios. No caller-supplied counts or SHA are sufficient to claim trusted native completion or provider invoice. The `verifiedNativeCompletions` field is intentionally **0** until a future independent real receipt verifier is delivered. Missing results are unknown; mutation retries are unsafe.

### Official published budget reference (verify account-specific plan before rollout)

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Free 100,000 requests/day; paid standard includes 10M requests/month plus $0.30/M and 30M CPU-ms plus $0.02/M. Worker WebSocket **initial Upgrade** is a request, later WS messages through a Worker are **not additional Worker HTTP requests**. Cloudflare says no additional transfer/throughput charge for Workers on the standard plan; other providers, relay services and ISP access can still cost money.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free 5M rows read/day and 100k rows written/day. Paid first 25B rows read/month and 50M written/month included. D1 row counts should come from query `meta`, account GraphQL analytics or dashboard. [September 1, 2026 enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/) means Free operations fail when daily row budgets are exceeded; raising Nexowire entitlements does not change that.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): separate request/message, duration, storage and hibernation costs. Do not treat DO charges as part of a single global Worker request counter.
- An **actual** operator account subscription, daily quota dashboard, Worker request analytics, D1 row metrics, DO duration/hibernation telemetry and external ISP/relay invoices were **not available to this test**. No authentic billing meter readings are reported; Cloudflare current provider prices are constraints, not measurements.

A practical cost accept check must reconcile all observed request/row/message/active-duration increments and their originating time windows with vendor metrics (and successful actual native completions), before/after a bounded authorized staging canary. A **free-tier arithmetic fit is not proof of zero additional invoice**. Do not provision paid resources or touch live DNS to obtain benchmark evidence.

## 3. Reproduction (bounded, isolated)

From the dedicated S5 worktree with Node >=22:

```powershell
npm run typecheck
node --test --import tsx test/scale-s5-protected-admission.test.ts
node --test --import tsx test/s5-protected-concurrent-writers.test.ts
node --test --import tsx test/s5-loopback-reconnect-storm.test.ts
node --test --import tsx test/scale-s5-resource-reconciliation.test.ts
```

No external target URL accepted. The only network sockets in the reconnect suite bind `127.0.0.1` ephemeral ports. Database writes use only temporary test SQLite files or `:memory:`; all temporary files and owned sockets are torn down.

## 4. Acceptance and stop conditions

**Source-test acceptance:** expected fair reservations match persisted rows, every duplicate is deduplicated or fails closed, no unauthorized cross-tenant admission, no wrong-plan policy change, backpressure is explicit, p95/p99 and socket/queue peaks are recorded, and **no completed native action is attributed to any mock**.

**Production still blocked:** reliable first-party authenticated tenant identities, true shared upstream ingress fairness, atomic multi-Worker/D1/DO admission, 100+/250+ *authorized WSS* simultaneous connections, native-agent result integrity and 24 uninterrupted hours of actual completed, correctly attributed tool operations. Must include real billing meters, spend hard stops, disconnected/revoked sessions, reconnect ambiguity and independent QA approval.

At 600/min, theoretical maximum is `600*60*24 = 864000` transport arrivals/day. A promised 850,000 **completed native operations** would require at least 98.38% of those theoretical slots continuously, leaving almost no discovery/retry/control headroom, without accounting for latency, failures or provider constraints. **850,000/day is an optional planning entitlement, NEVER a guaranteed successful-work capacity or production acceptance.**

No 24-hour native soak completed. Production acceptance remains **NO-GO** regardless of synthetic CI green status.
