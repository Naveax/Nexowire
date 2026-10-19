# Scale v2 S5: external WSS / native completion / Cloudflare staging acceptance

**2026-10-19. Issue #487, parent #482. Previous PRs #557, #564, #571 MERGED.**

## Acceptance boundaries

| Scope | Observation | Status |
| --- | --- | --- |
| Source: protected fairness and local SQLite | Previously merged local 300/300 and 570/30 strict shares; concurrent writers, replay/rollback. New offline provider snapshot and staging evidence guards tested separately | Source-level only; never production pass |
| Staging: 101–128 real simultaneous authorized WSS | **No authorized isolated external WSS hostname, signed enrollment, 101+ physical authenticated sessions or owner-approved rate/billing envelope discovered** | **BLOCKED / NOT_TESTED** |
| Staging: native tool completion | Previous fixtures expressly report 0 native effects; no independently verified read-only Agent completion receipts | **BLOCKED / NOT_TESTED** |
| Staging: rate/fairness/reconnect/p95/p99 | Old peak **21 concurrent local WS** in 360 cumulative connections, not 101+ remote WSS. No provider-fairness proof | **BLOCKED / NOT_TESTED** |
| Staging: Cloudflare metrics | Cloudflare GitHub Actions secrets exist, but are not permission to use live billing resources. No operator-authorized **staging** Worker/D1/DO account counters or invoices | **BLOCKED / NOT_TESTED** |
| Production: 24h continuous native tool soak | No 24-hour run with real verified completed native effects and provider billing evidence | **NO-GO** |

**Work PC safety:** 2026-10-19 sampled CPU at 100% (later 59%); available disk roughly 14–15 GB, over 93% used. No local 100+ or 24-hour background stress is authorized by these resource conditions; do not dispatch load against the user's normal work session. Work PC's Agent 1.0.5 and Naveax's Agent 1.0.5 are unchanged.

## New source-only controls

- `src/ops/scale-s5-staging-acceptance.ts`: strictly bounded external run authorization **data schema**; 101–128 sessions, at most 8 new connections/second, at most 600 read-only logical requests per run and 90 seconds runtime, an operator-approval reference, isolated staging resource identifier, pinned TLS-trust profile hash, signed enrollment manifest hash, two or more authenticated tenant identities and explicit no-paid-resource contract. This is **a validator, not an external dialer or permission grant**. Even a fully populated JSON with plausible signatures returns `NEEDS_INDEPENDENT_AUDIT`, never PASS.
- `src/ops/scale-s5-provider-meter-evidence.ts`: before/after Worker HTTP request and CPU, D1 rows read/write and Durable Object message/duration **delta**, scoped to the exact same opaque account/resource references and UTC sampling interval. Mismatched resource, reversed clock, negative/counter reset, bad precision, absent D1/DO resource mapping fail closed. If D1/DO counters are unavailable, report `null`, never zero. A snapshot text export cannot prove authentic Cloudflare billing; `providerAuthenticated=false`, `providerCostUsd=null`, `zeroIncrementalInvoiceProven=false`.
- `scripts/report-s5-staging-readiness.ts`: runs **no network requests, no WSS connections and no native tools**. Without an external approved manifest it prints BLOCKED. With JSON evidence it performs only structural audit; independent provider/tool-result verification remains required.
- `test/scale-s5-staging-acceptance.test.ts`: explicit negative regression: 360 cumulative reconnects, peak 21, insufficient proof; fake 112 concurrent WSS stays external-audit pending, paid-resource authorization is refused, wrong hostname, fabricated native completion/counter and missing artifacts are denied.
- `test/scale-s5-provider-meter-evidence.test.ts`: distinguish 300 Worker HTTP calls, 650 D1 reads, 130 D1 writes, 16 DO request units, 2.5 GB-s duration (all **synthetic counter samples**), native completions always unknown; no account-bill authentication.
- No code imports these staging-only guards from production Worker/Hub/MCP/Agent. No DNS, Cloudflare D1 migrations, WSS origin or plans edited.

## Proposed *future authorized* physical staging acceptance protocol

The following is a **test plan only**, not a record of executed staging traffic.

1. Operator supplies disposable staging resource IDs, exact WSS hostname, first-party signed device/tenant enrollment, trustworthy public TLS trust/pin material, owner approval and account-specific billing/spending restrictions. Without **all**, do not dial.
2. Execute a small authenticated TLS/WSS smoke with real proof of native read-only tool completion and immutable result artifact digest + Agent journal correlation: `requestId`, device ID, owner/account, session generation, real completion time, native exit/result hash and signature/attestation. A quota reservation, transport ACK, Hub send or self-reported completion flag **does not count**.
3. Slowly scale **16 → 32 → 64 → 101 → 128** concurrent authenticated connections, not merely cumulative opening events. Use a maximum ramp of 8 WSS connections/s, independent 95:5 tenant load, scoped provider stop budget, unique replay-safe invocation IDs and no unbounded work queues. Native commands must remain expressly authorized, harmless and read-only, with bounded CPU/disk duration. Stop on provider 429, 5xx, transport auth anomaly, unexpected bill, lost completion evidence or resource contention.
4. At every load step record at least p50/p95/p99 real RPC completion latency, max concurrently *authenticated* WSS, TCP/TLS handshakes, queued/in-flight, backpressure rejections, reconnect epoch and stale ACK, failed/unknown mutations, per-tenant reserved vs native completed, Jain fairness based on demand-normalized admissions, and zero cross-account scope bleed.
5. Read **actual isolated provider account** Worker inbound HTTP requests (including WS Upgrade, excluding later WS messages), Worker CPU, D1 rows read/write, DO requests and 128 MiB duration GB-s (only if DO actually used), storage and account bill/invoice; join time windows and account/resource identity to the native receipt report. A hypothetical cost model cannot demonstrate no additional owner invoice.
6. A **separate** operator-approved real 24-hour continuous soak must cover UTC boundary, restarts, revocation, quota exhaustion, crashes and recovery with independently verified native completion counts. This 90-second canary validator **cannot** PASS a 24-hour soak. Production NO-GO until an external auditor reviews uninterrupted evidence, incident history and verified billing.

## Provider accounting references

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Worker initial WebSocket Upgrade counts as one Worker HTTP request; subsequent WebSocket messages do not individually count as additional Worker HTTP requests.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): 5M rows read/day and 100k rows written/day on Free, query `meta` / Cloudflare GraphQL / account dashboard for actual rows. Cloudflare D1 Free query limits are enforced.
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): separate request billing, 20:1 incoming WebSocket-message accounting and hibernation/awake duration billing; validate current account plan and whether this topology is even deployed.

**Global 600/min is only a transport admission constraint.** At theoretical 864,000 arrivals/day, 850,000/day would consume approximately 98.38% of the entire transport ceiling continuously before authentication, health checks, telemetry, retries, reconnections, failures or actual tool execution. **Do not represent 850,000 as guaranteed successful native tool completions.** The present Free plan remains 1,000 weighted credits per UTC month; no future daily package or paid tier has been enabled.

## Reproduction (offline, bounded)

```powershell
node --test --test-concurrency=1 --import tsx test/scale-s5-provider-meter-evidence.test.ts test/scale-s5-staging-acceptance.test.ts
npm run typecheck
node --import tsx scripts/report-s5-staging-readiness.ts
```

The report CLI without evidence must exit code 2 with `BLOCKED`: this is a **successful fail-closed behavior**, not a failing production operation. External/provider tests were **not** run.
