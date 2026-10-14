# Scale v2 — Quota semantics, capacity math and zero-owner-spend budget

> **PROPOSAL, NOT DEPLOYED.** See [vision](SCALE_V2_VISION.md), [roadmap](SCALE_V2_ROADMAP.md), [active Free-only policy](FREE_ONLY_POLICY.md), [quota identity](QUOTA_IDENTITY.md) and [product baseline](PRODUCT_CONTROL_PLANE.md). Tracking: [#484](https://github.com/Naveax/Nexowire/issues/484), [#486](https://github.com/Naveax/Nexowire/issues/486), [#487](https://github.com/Naveax/Nexowire/issues/487).

## 1. Current truth versus planned entitlements

| Dimension | Repository-documented existing policy | Scale v2 planned policy |
| --- | --- | --- |
| Normal hosted Free usage | 1,000 **weighted units / UTC month**; 1x ordinary, 5x special | 1,000 **logical hosted requests/day** per canonical Free quota subject (exact weight mapping must be approved) |
| Plus | Paid checkout paused; underlying older plan envelope is not live approval | 5,000 requests/day, payment/activation only after separate approval |
| Pro | Paid checkout paused | 10,000 requests/day, same gate |
| Enterprise | Custom/prepaid design exists but checkout paused | Explicit negotiated organization/seat/relay/compute quotas |
| Period start | 00:00 UTC first calendar day of month | 00:00 UTC each day for the proposed daily tiers |
| Overages | Deny before execution | Same fail-closed; no owner-paid/postpaid surprise |
| Local self-hosted requests | Outside hosted quota by design | Preserve; still CPU, security and network policy bound |
| Owner exception | Verified owner-specific unbounded **Nexowire hosted tool credits**, not external platform capacity | Must be migration-tested separately; never silently grant all users unlimited resources |

**Decision pending:** If a special-skill request costs 5 units while a daily plan is advertised in **requests**, either provide a separate bounded weighted-unit budget or explicitly define "1 request" as a weighted charge. Do not promise Free "1,000 requests" and then silently consume five from that advertised count. Version the metering contract, show both counters if needed and obtain owner signoff before implementation.

## 2. Distinct resources that MUST have different budgets

1. **Hosted logical request:** authenticated MCP/Nexowire invocation; always checked at a server-authoritative authorization+quota boundary before dispatch.
2. **HTTP ingress request:** actual Cloudflare Worker/Hub HTTP entry. This is infrastructure usage **even if** a single logical request triggers 100 local operations.
3. **Local fan-out step:** optional bounded task-graph child on the authorized device. It is not the same as a new ChatGPT-hosted MCP tool request; still audited and resource-limited.
4. **Control/signaling call:** auth/pairing/refresh/heartbeat/rendezvous/lease negotiation. Can also consume hosted HTTP and D1 operations.
5. **Transport usage:** bytes of direct E2E, relay GB/minutes, stream concurrency, TURN allocations, retries.
6. **Device compute:** local CPU/GPU/disk and process concurrency; must not become an invisible paid service burden or unbounded machine consumption.

Only after measuring these dimensions can we say a user quota is sustainable. An Enterprise contract must specify all priced/rate-limited dimensions rather than assume "unlimited".

## 3. Capacity budget formulas: avoid magical Cloudflare bypass

Define:

- `U` active users per day;
- `q` average **hosted MCP calls/user/day**, not headline entitlement;
- `h` hosted Worker invocations per tool call (at least 1 if each calls that Worker);
- `a` extra per-user/day auth, quota UI, pairing, heartbeat and control HTTP calls;
- `w` infrastructure requests/day available under the **currently verified** selected hosting plan;
- `r` average fraction of payload bytes relayed instead of direct; `b` MB/user/day transferred.

A conservative daily estimate (before retries/background jobs):

```
hosted_requests_per_day = U * (q * h + a)
relay_GB_per_day = U * b * r / 1024
request_headroom = w - hosted_requests_per_day
```

These are planning variables, **not measured production values**. If using a hypothetical 100,000-request/day pool solely as an illustration and `h=1, a=0`:

| Active users/day | Mean hosted calls/user/day | Required hosted ingress/day | Fits 100k illustrative pool? |
| ---: | ---: | ---: | --- |
| 100 | 1,000 | 100,000 | Barely; zero signaling/retry headroom |
| 1,000 | 1,000 | 1,000,000 | **No** |
| 10,000 | 200 | 2,000,000 | **No** |

**Key constraint:** If a ChatGPT-hosted MCP call hits Nexowire's Worker once, no device-to-device P2P design can make `h` less than one for *that same hosted request*. Coalescing/batching 100 device-local actions behind one authorized MCP call can reduce **new MCP calls initiated by workflows**, not retroactively erase calls the host already sent. WebRTC/QUIC shifts large first-party streams off the hosted relay only when both clients support that transport. Without paid capacity, a saturated free pool must throttle or reject; it cannot grant infinite capacity.

Cloudflare, D1, TURN, CI, domain and provider price/plan terms change. **Fetch authoritative current prices/limits at rollout**, model paid bandwidth, and implement fail-closed spend caps before provisioning any paid resource. Do not build an architecture that depends on splitting accounts/projects to evade service limits.

## 4. Authoritative quota ledger — proposed contract

### Data model

```
quota_subject(id, type=free_cluster|subscription|organization, owner_id, plan_version)
plan_entitlement(subject_id, plan, active_at, expires_at, billing_status, version)
usage_bucket(subject_id, utc_day, credited_or_consumed_units, version)
invocation_event(subject_id, utc_day, invocation_id, request_digest,
                 reserved_units, decision, created_at)
transport_budget(subject_id, utc_day, relay_bytes, concurrent_leases, grant_id)
```

Adapt this *conceptually* to the existing D1 tables and migrations; **do not create duplicate tables or reset historical usage without an audited migration**. Reuse the current hashed Free device-anchor merge semantics, preserve old monthly usage history and paid/Free subject separation.

### Reservation lifecycle

1. Authenticate caller, resolve account/organization, verify owned device and tool permission, then obtain server-side plan and effective quota subject.
2. Normalize validated invocation ID and authenticated payload digest; transactionally inspect `(subject, day, invocation_id)` and remaining budget.
3. First valid reservation atomically decrements budget **before dispatch**; replay of same ID+digest does **not re-execute** and preserves existing 409/unknown-state contract. Same ID different digest is conflict, not quota-free execution.
4. Dispatch with bounded target, time and output. Audit completion separately. A crash/reconnect must not replay an unknown mutation; release/resolution rules must be explicit and proven with tests.
5. Exact UTC day rollover chooses server time, never client clock. Plan changes take effect under a deterministic signed event sequence, not dashboard cached text.
6. Offline/P2P lease is narrowly scoped, pre-reserved, short-lived, byte/resource bounded; exhausted/expired/revoked lease denies further remote paid execution, with no unmetered offline loophole.

### Mandatory negative tests

- 1, 10, 100 and 1,000 concurrent reservations across independent Worker instances; no double-spend at last available unit.
- 23:59:59.999 UTC then 00:00:00.000 UTC with deliberate retry delay and repeated IDs.
- Wrong account/device/org, missing permission, stale pairing, client-forged plan, canceled payment, refund debt and re-paired identity.
- Same free device anchor under second login; no extra Free grant; paid quota remains separate.
- Network retry, intentionally repeated call, idempotent replay, old MCP session request-id reuse, double webhook and partial DB outage.
- Cross-tenant output/ledger separation; no token, raw anchor, command payload or private screen frame in metering records.
- Daily + concurrency + relay-byte + CPU hard stops, all enforced before the relevant expensive operation.

## 5. Subscription safety (S4) and Enterprise

- Keep `NEXOWIRE_PAID_BILLING_ENABLED` off in existing production. Do not activate by plan document, user birthday, provider credential presence or CI success.
- Signed webhook verifies store/provider identity, monotonically reconciles subscription status, persists deterministic event IDs, never grants on unsigned or out-of-order unverified events.
- Map Plus/Pro variant **server-side**; Enterprise organization membership/role and contracted usage budgets must be owner-authenticated and revocable.
- Usage must be prepaid or already funded; if purchased relay budget is exhausted, degrade to direct where safe or **deny**, not rack up the owner's invoice.
- Document refund clawbacks/debt, cancellation grace, paid-to-Free transitions, reporting of used/remaining/reset and no automatic silent downgrade to an insecure feature scope.

## 6. Load evidence worksheet (to fill, not invented)

| Metric | Actual baseline | S1–S5 acceptance result |
| --- | --- | --- |
| Worker HTTP requests / logical MCP call | **UNMEASURED** | TBD after instrumentation |
| D1 reads/writes per logical hosted call | **UNMEASURED** | TBD |
| Direct success by network class | **UNMEASURED** | TBD |
| Relay fallback fraction / bytes | **UNMEASURED** | TBD |
| p50/p95 connection and reconnection | **UNMEASURED** | TBD |
| p95 quota reserve latency under contention | **UNMEASURED** | TBD |
| 100/1k/10k tenant sustained concurrency | **NOT ACCEPTED** | TBD |
| Estimated cost at user mix / hard-stop budget | **NOT VERIFIED** | TBD |
| Existing two Agents remain online after canary | **OBSERVED AT PLANNING CHECKPOINT** | Recheck at each stage |
| Current Free-only policy intact until approval | **DOCUMENTED** | Require live version proof |

**The acceptance decision is based on real measured numbers and CI SHA, not on Free/Plus/Pro marketing entitlements.**
