# Scale v2 — Elastic per-tenant HyperScale architecture (proposal, not deployed)

**Date:** 2026-10-15. **Scope:** S1–S6 capacity intent; immediate planning applies to the approved S1–S5 program only, and does NOT unpark S6 features. This file does not authorize Cloudflare Workers Paid billing, production deployments, D1 migrations or Agent/Hub/Broker restarts.

**HARD OWNER CLARIFICATION / ARCHITECTURE PRIORITY:** **$0 additional OPERATOR CLOUD INVOICE.** The intended product architecture is now LOCAL-FIRST: tool execution, MCP hosting wherever safely supported, queues and state should live on the *user's existing PC*; a self-hosted owner-managed ingress may still be essential for trustworthy commercial quota enforcement. Cloudflare Tunnel can proxy an origin without running a billed Worker+D1 application per tool. The Paid Worker/D1 pricing scenarios below are **counterfactual comparison only, NOT a recommendation or funded architecture**. Read [Zero operator cloud bill / local-first contract](SCALE_V2_ZERO_CLOUD_BILL_LOCAL_FIRST.md) before proposing any rollout. 10M/user/day remains a lab target, not a hardware throughput promise.

## Decision: two unrelated ceilings

1. **Commercial entitlement** is only a server-authoritative *logical tool calls/day* counter per canonical quota subject and plan version. Future target, **OFF**: Free 1,000; Plus 5,000; Pro 10,000; Enterprise configured. Changing plans changes the call limit and corresponding reset/version rules; it does NOT alter the user's available tools, permissions or processing model. Separate safety/abuse/concurrency safeguards apply uniformly and are not hidden plan features. The current effective policy remains Free-only **1,000 weighted credits per UTC month**, 1x normal, 5x special skills, and billing paused.
2. **Infrastructure throughput/capacity** is the number of requests the system can physically, economically and securely process across many users, independently of account plan. A single user's **10 million tool calls/day** is an **extreme synthetic load acceptance objective**, not permission for a 1,000/day Free user to make 10 million calls. No system is literally infinite. The architecture removes fixed per-process/per-shard user limits while enforcing real provider, hardware and operator cost budgets.

A single user at 10M/day needs **~116 logical requests/second on average**, and **~1,158/s** at ten times average peak. 1k such users need 10B requests/day and create 115,741 average logical requests/sec. These are mathematical workloads, NOT measured throughput.

## Grounded current hosted route and physical bottleneck

Existing `src/security/auth.ts` + `src/mcp/http.ts` -> `src/hub/control-plane-mcp-auth.ts` performs one `POST /api/v1/internal/mcp/authenticate` and one `POST /api/v1/internal/usage/charge` for a normally accepted hosted tool call, as tested by `test/scale-worker-capacity-model.test.ts`. These are **two control-plane Worker requests** per accepted tool, before other signaling/retries. The hosted MCP ingress may exist on a separate Hub route; do not double-count it without network measurement. See `docs/SCALE_V2_S1_WORKER_INGRESS_FANOUT.md`.

Cloudflare Workers Free has **100k requests/day**. Workers Paid (as documented Oct 2/12, 2026) has no general daily Worker requests or requests/second limit, **but excess requests/CPU and database operations are billed**. D1's **individual database is single-threaded** and its maximum throughput is bounded by query duration: it must not become a universal shared hot-key. Durable Objects likewise have a **soft ~1,000 requests/second per individual object**, not a global namespace ceiling.

Sources to refresh before owner approval:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

## Target architecture: independently scalable identity, hot tenants, execution

**This section sketches a cloud-hosted alternative for cost comparison, NOT the selected no-cloud-bill deployment.** The owner-selected target is the per-user PC + low-overhead authenticated tunnel and an existing owner-hosted trusted meter wherever central quotas are required. See [local-first target](SCALE_V2_ZERO_CLOUD_BILL_LOCAL_FIRST.md).

```text
ChatGPT-hosted MCP / first-party client
              |
         HTTPS + OAuth
              v
Cloudflare global stateless gateway (Worker)
  - validate request syntax and origin; no untrusted account/plan claims
  - one AUTHENTICATE + OWNER/DEVICE/CAPABILITY + RESERVE operation
  - stable invocation ID + payload digest; fail-closed replay
  - server-only entitlement lookup and budget checks
              |
    per-tenant partition router
       |                     |
       v                     v
 Tenant coordinator A    Tenant coordinator B ... (horizontal)
 (Durable Object or       (each owns its own durable quota/version,
  isolated D1 shard)       consent/revocation epoch, reservation ledger)
       |                     |
       +--------+------------+
                v
      bounded execution dispatch
      authenticated existing Hub/WSS Agent
      optional E2E direct path only for supported clients and authorized peers
      optional funded relay for large data, otherwise deny safely
```

### Critical rules

- **1 Worker ingress per accepted hosted tool** is a target for the *current two-control-call route*. This requires moving auth, epoch/device-owner authorization and quota reservation into one atomic server-side operation. A naive combination that checks auth and quota in separate independent transactions is NOT acceptable; test 409 replay, old-owner/device, logout between checks, D1 outages and UTC rollover before any cutover.
- **No per-user pinned Worker, agent process or database connection.** Stateless Edge Workers scale by demand; shard stable server-derived tenant IDs across Durable Objects (per-subject actors) and/or D1 databases. Keep globally shared identity/metadata small and indexed; don't send every request to one global SQL writer.
- **Hot-tenant throughput:** one account at ~1,158 peak RPS can exceed the DO per-object soft limit of ~1k RPS or a slow per-DB writer. Use bounded queues/backpressure initially. For hard peak acceptance, a trusted allocator can reserve **finite blocks of call tickets** from the canonical daily counter, split high-rate request execution across shards, and reconcile consumption. Tickets must be subject/epoch/plan/day/scopes bound, short-lived, single-use, provably non-overissuing, not transferable, revoked on logout/plan downgrade and fail-closed during partition/outage. This is a proposed hard engineering problem, NOT implemented. Do not cache a revocable OAuth permission merely because quota tickets were pre-reserved.
- **The user machine does the user's compute.** Hosted ingress, authentication, call counting and audit are central trust-boundary operations; authorized Agent performs local tools. No background process duplication or mandatory VPS/user configuration. P2P only reduces eligible large payload transfer, never exempts an incoming ChatGPT-hosted MCP tool call from Cloudflare ingress/quota.
- **Unbounded commercial demand needs finite financial safety.** Operator-approved daily/monthly spend ceiling and provider account monitoring; per-subject fairness and bounded per-worker CPU/queue/concurrency. A budget trip returns a transparent refusal/degraded result, not unmetered execution or surprise charges. This means "unlimited platform capacity" must be understood as dynamically extensible, not a promise of infinite free capacity.
- **Plan-change isolation:** plan change only changes `dailyToolCallLimit` in a versioned entitlement. Tool access itself remains independent and owner/device capability driven. A privilege change, revoked device or logout still invalidates authority regardless of tier. First-party external quotas and cost control are not silently waived by an Enterprise plan.

## Conservative provider-cost model (NOT a real invoice)

**Comparison baseline only:** the owner explicitly rejects incremental cloud-provider charges. Do not implement the Paid Workers/D1 design under a $0 operator-cloud-bill promise. Model examples below quantify why the Worker-per-tool alternative is a NO-GO for that constraint.

See `src/ops/scale-elastic-capacity-model.ts` and `test/scale-elastic-capacity-model.test.ts` for exact integer math, errors and scenario reproducibility. Workers Paid rates as of 2026-10-15: base **$5/month**, 10M included Worker requests and **$0.30/million** beyond. D1 Paid includes **50M written rows/month**, then **$1/million**; reads 25B included, then **$0.001/million**. Example assumes 30 days, no retries, **one D1 row write per accepted tool call**, one read, and one control-plane Worker request per call. Real route costs differ.

| Workload | Worker requests/month | Worker modeled cost | D1 written-row modeled cost | Partial monthly total |
| --- | ---: | ---: | ---: | ---: |
| One stress tenant at 10M calls/day | 300M | $92 | $250 | **$342** |
| Same stress tenant, current 2 Worker calls | 600M | $182 | $250 | **$432** |
| 1,000 active users x 1,000 calls/day | 30M | $11 | $0 | **$11** |
| 100,000 active users x 1,000 calls/day | 3B | $902 | $2,950 | **$3,852** |

**These are only Worker request/base + D1 billed row dimensions.** Excluded: billed Worker CPU, Durable Objects requests/duration/storage, D1 storage, retries' extra reads, NAT/TURN relays, Hub servers, network operations and taxes. No single-user 10M/day commitment or measured latency guarantee. Cloudflare Paid is metered, not no-cost unlimited. A source price change requires updating the model/test.

**Per-user plan limit does not scale cloud bill one-to-one:** an account paying more merely has higher authorized demand. Additional users and usage still cost the operator and require a sustainable revenue/budget policy, even when users see the same feature set across plans.

## Phased implementation and release gates

**Replacement priority:** Z0–Z5 in [local-first zero-cloud-bill design](SCALE_V2_ZERO_CLOUD_BILL_LOCAL_FIRST.md) takes precedence over the H0–H5 paid-edge exploration below. H1–H3 may still be benchmarked in disposable local mocks to compare semantic correctness, but **must not provision paid cloud services**.

- **H0 (read-only telemetry and deterministic planning):** capture per-tool hosted Worker requests and actual D1 rows read/written, CPU time, relay bytes and p50/p95/p99, redacted; verify current account plan, baseline and no-disconnect two-device state. Pure offline workload model lives in this PR.
- **H1 (one-call control-plane admission, staging):** new versioned endpoint `authorizeAndReserve`, server derives token/account/device/plan, canonical request digest+ID, atomic reserve-before-dispatch; retain old two-call route behind an OFF-by-default feature flag. Test denied/revoked/no-charge/ambiguous ACK/duplicate/UTC boundary and request source authentication.
- **H2 (per-subject partition, staging):** compare SQLite-backed Durable Object per subject versus D1 shard layout. Prove 1, 10, 100, 1,000 tenants with concurrency, per-tenant isolation and cross-region consistency. Check DO request and storage charges; no need to create one Worker per user.
- **H3 (hot tenant load, staging):** 10M/day/user synthetic traffic at 116/s average and tenfold peak. If coordinator bottlenecks, prototype bounded quota ticket leases with strict reservation conservation and epoch fences. Fail-closed overload and revocation must hold under partitions.
- **H4 (data-plane fan-out):** use existing authenticated outbound WSS Agent; optional owner-authorized P2P for large payloads and bounded relay; ingress/auth/ledger remain centralized. Never silently bypass hosted logical calls.
- **H5 (cost and canary):** real isolated Cloudflare Worker+D1/DO instrumentation with hard budgets, clearly separated staging database, cleanup, rollback, 2-device no-disconnect acceptance; then separately approved production rollout. Do not run high-rate production load tests or billable provisioning automatically.

## Not done

No live combined endpoint, tenant sharding, preallocated tickets, P2P, provider-scale load, spending cap, production feature flag, billing activation, D1 migration or Agent restart is included here. The current GitHub S1–S5 checklists remain unaccepted. S6 remains deferred unless separately prioritized.
