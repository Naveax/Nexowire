# Scale v2 S5 follow-up: simultaneous ingress race, fairness and Durable Object cost

**Further isolated acceptance:** [Protected tenant admission, bounded reconnect storm and source-separated cloud/native metrics](SCALE_V2_S5_PROTECTED_FAIRNESS_THROUGHPUT_ACCEPTANCE_20261018.md). This is a staging-only prototype; it does not change current production quotas or provider-side ingress policy.

Date: 2026-10-18. Parent [#487](https://github.com/Naveax/Nexowire/issues/487), PR [#557](https://github.com/Naveax/Nexowire/pull/557). DEV ONLY, draft, **production NO-GO**.

## Scope and reproducible measurements

- `test/s5-ingress-concurrent-rate.test.ts` and `test/fixtures/s5-ingress-parallel-worker.ts`: four **real Node worker threads**, four independent SQLite connections on one **same physically shared local** SQLite WAL/FULL DB. The production code under test is `ProposedAllIngressTransportMeter.observe`. Barrier launches 4 * 155 calls in one frozen UTC minute to one trusted synthetic transport scope.
- Assertion: **620 attempts -> 600 admitted, 20 denied, 600 persisted admission rows, 620 monotonic transport observations**, rolling limit exactly 600; denied samples return 60,000ms retry-after. Lower owner limit: 4 * 24 -> **64 admitted, 32 denied, 64 rows**. Another independently trusted scope retains its own counter; 60,001ms advance reopens the original scope's rolling window.
- No actual provider HTTP/WSS requests or native executions. This does **not** prove OpenAI shared transport budget behavior, production multi-region D1 atomicity or sustainable 600/min across a day. It checks single-host SQLite writer safety under race, unlike the serial 600 sample test.
- Hard bounded: max 4 threads, max 155 attempts per thread, max 600/min setting, temporary WAL, 15-second barrier and clean teardown. If the test times out or SQLite has ambiguous commit status, acceptance fails.

## Fairness counterexample, not a fairness victory

The current global `ProposedAllIngressTransportMeter` is **first-come**, not a fair per-tenant scheduler. Reproduction with one transport scope:

| Synthetic order | Demand | Allowed | Denied |
| --- | ---: | ---: | ---: |
| Noisy account A arrives first | 600 | 600 | 0 |
| Quiet account B arrives afterward | 20 | 0 | 20 |

Global limit correctly denies beyond 600, but B is starved. Request admission ratios: A = 1.0, B = 0.0. The Jain index over normalized per-tenant admission ratio is **0.5** (not fair). An unnormalized count-only Jain index can misdiagnose legitimate demand differences: 600/600 and 20/20 both achieve 100% demand fulfillment, yet have very different raw request counts. Use `analyzeS5Fairness` for demand-normalized reporting, and maintain tenant IDs outside telemetry payloads. This fixture uses only two synthetic account groups; it is not actual customer traffic or multi-tenant QoS.

**Required before fairness acceptance:** explicit per-tenant concurrency/admission policy under a shared verified provider scope, 95/5 skew and burst/reconnect/401 mixes, weighted queues or leased capacity (including starvation prevention), authenticated account/device mapping, tenant-isolated counters, intentional exhaustion, and durable time-window fairness. Do not raise global limit to "solve" starvation. Enforce quota at trusted ingress and keep unverified customer headers outside the identity key.

## Optional Cloudflare Durable Objects and WSS bill-model caveats

`src/ops/scale-s5-durable-object-cost.ts` adds a **non-runtime**, assumption-driven model of DO requests plus DO awake/hibernation duration. It does NOT claim Nexowire production uses a DO or that the WSS origin is hosted by DO. Inputs declare number of DO instances and awake seconds **per object**, not per socket, because duration is billed by the object's active lifetime. Cloudflare bills incoming WebSocket messages with a **20-to-1 compute-request** factor; the model aggregates frames globally and may therefore UNDERESTIMATE when billing is divided across individual objects/sockets or RPC methods.

Illustrative scenario: 100 synthetic daily active users, 205 logical calls/user, one socket/user, one connection upgrade/socket/day, one incoming message/call, no extra DO RPC, and 30-day month. DO frame+Upgrade approximation is **1,125 DO request units/day**:

| DO origin assumption | Modeled DO awake GB-seconds/day | DO Free 13,000 GB-s/day duration budget? |
| --- | ---: | --- |
| One DO, hibernated when idle (modeled active duration 0) | 0 | Numeric fit only |
| One DO fully awake 24h | 10,800 | Numeric fit only |
| Two DOs fully awake 24h | 21,600 | **No** |

The above table is emphatically NOT a forecast of Nexowire's actual DO object count, awake time or invoice. Real DO CPU/hibernation, request volume, storage and peak topology must come from operator metrics. **Outbound WebSocket clients of a DO cannot use incoming-server WebSocket hibernation**; a server DO's unhibernated WebSockets can continue accumulating duration. A WebSocket upgrade routed through a Worker may also incur a separate Worker HTTP request. Neither disappears merely by using P2P.

**Official references checked October 18, 2026:**

- [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/) (updated October 12, 2026): 100k Worker requests/day, 10ms CPU/invocation; this is not 100k successful native Nexowire actions.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (updated April 21, 2026): 5M reads/day, 100k writes/day Free; [enforcement began September 1, 2026](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/), overages on Free fail operations rather than enabling unplanned spending.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (updated September 30, 2026): 100k DO requests/day, 13k GB-s/day Free. Paid monthly included 1M requests and 400k GB-s; overage pricing for DO *alone* is $0.15/million requests and $12.50/million GB-s.
- [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (updated September 30, 2026).

**Zero-owner-added-invoice acceptance remains BLOCKED:** actual Worker/D1/DO per-account dashboard metrics, any paid plan base, external tunnel, operator LAN/ISP egress, relay traffic, connection duration, requests, signed receipts and binding to Nexowire tool-completion counts are not available. A free-tier numeric fit is necessary but insufficient.

## Soak evidence safety improvements

`scripts/s5-soak-acceptance.ts` is metadata validation only. It now rejects duplicate/out-of-order timestamps, gaps over 2 minutes, regressing cumulative completion count, zero actual reported completions, missing content hashes, missing traceable staging approval, malformed metrics and incomplete 24h coverage. The CLI limits evidence files to 10MB. The accepted metadata flag can be true if input fields structurally pass; **`productionAccepted` is ALWAYS false** because hashes, self-asserted booleans and owner approval strings cannot independently authenticate their claimed origin. A final auditor must verify provenance and sign physical acceptance separately. Existing local-only soak runner regenerates a database for each sample and never substitutes for 24h continuous WSS/DB load.

## Reproduce without provider traffic

```powershell
node --test --import tsx test/s5-ingress-concurrent-rate.test.ts test/scale-s5-fairness-analysis.test.ts test/scale-s5-durable-object-cost.test.ts test/s5-soak-acceptance.test.ts
node --import tsx scripts/report-s5-fairness-do-risk.ts
```

The command prints explicitly labeled synthetic scenarios and cannot connect to an external endpoint. It cannot be used to assert external staging success, an actual provider bill or a 24h run.

## Remaining gates

1. Provider-side 600/min shared ingress enforcement with real audience/scoped identity, accounting for retries/metadata and device revocation.
2. Staged 16, 32, 64, 100 and 250+ **externally authenticated WSS** sessions, CPU/RSS, p99/p999 and real tool results; separate provider cap from SQLite cap.
3. Measured multi-tenant noisy-neighbor fairness, per-user quota and cross-account ledger isolation at actual admission.
4. Real Cloudflare account budgets, DO/WSS placement, ISP bandwidth and zero-unapproved-bill hard-stop before any canary.
5. Full uninterrupted 24h owner-approved staging soak and independent acceptance artifacts. No live quota/plan/DNS, firewall, Agent or DNS changes from this PR.
