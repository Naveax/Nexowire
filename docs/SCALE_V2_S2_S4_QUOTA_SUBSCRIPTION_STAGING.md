# Scale v2 S2/S4: Quota engine and subscription entitlements (DRAFT, NOT LIVE)

**18 October 2026 | Issues #484 / #486 | Production cutover: NO-GO.**

## Existing system is unchanged

The running policy documented by [FREE_ONLY_POLICY.md](FREE_ONLY_POLICY.md) remains **Free 1,000 weighted credits per UTC calendar month**, ordinary tool 1x and special skill 5x, with a server-verified repository-owner exception for hosted tool credits. `NEXOWIRE_PAID_BILLING_ENABLED` remains OFF; billing checkout routes still return `503 BILLING_PAUSED` and no payment/real subscriptions are created. This proposal does **not** modify `cloudflare/migrations/`, `cloudflare/worker.js`, `BillingService`, `ControlPlaneService`, `PRODUCT_PLANS`, the Hub, the Agent, or dashboard routing.

The separate, future-only envelope is:

| Proposal | Logical hosted root invocations / UTC day | Rolling minute / subject | Legacy monthly weighted credits |
|---|---:|---|---|
| Free | 1,000 | Not specified | Current Free cap continues until approved migration |
| Plus | 5,000 | Not specified | Must be explicitly contracted, not inferred from daily calls |
| Pro | 10,000 | Not specified | Must be explicitly contracted |
| Enterprise/Custom | Positive, contracted; example at most 850,000 | Explicit finite contract; example at most 600 | Explicit finite contract; never implicit infinity |

**Important:** 600/min as a Nexowire contract ceiling does NOT increase any OpenAI tunnel or Cloudflare provider limit. 850,000/day has not been physically validated; no sustained throughput or price promise is made.

## Deliverables in this branch

- `src/product/subscription-entitlements-v2-proposal.ts`: a strictly offline, typed `QuotaEntitlementSnapshotV2` contract, `evaluateQuotaEntitlementV2`, and `billableInvocationV2`. The paid candidate switch defaults to false in its caller and the paid billing production switch remains typed as `false`. Contract includes account, tenant, quota subject, device owner, membership, subscription status, signed-provider-derived settlement evidence, revision, time bounds, finite limits, and consent snapshot. `ACTIVE` alone is **not sufficient** without verified payment, matched account, nonexpired contract, active provider status and explicit consent. `PAST_DUE`, `CANCELED`, chargeback, refund and trial are denied by this conservative proposal; commercial grace periods require a separate product decision.
- `src/product/v2-quota-d1-staging.ts`: server-side-only candidate adapter. One `v2_quota_reservations` insertion invokes nested **rolling 60s / UTC day / weighted-credit monthly** enforcement atomically using SQLite triggers. No partial monthly debit when a daily/minute bound fails. A replay returns `duplicate`; this MUST be interpreted as *do not execute*. An unknown D1 commit outcome is never treated as success.
- `test/fixtures/scale-v2-tenant-minute-dual-staging.sql`: **not** a deployable migration. Adds pinned account/tenant/subject grant epoch, permitted daily/minute/monthly bounds, paid-tenant exclusivity, device owner SQL check, idempotency key without a day component, a monotonic time fence, and an atomic nested dual-ledger reservation. `v2_quota_authority` is an internal projection of separately validated source records, never client-provided. Revocation / plan changes require a transactional version advance or `state=revoked`; stale decisions fail at database admission.
- `test/subscription-entitlements-v2.test.ts` and `test/v2-quota-d1-staging.test.ts`: synthetic subscriptions, consent, device/tenant attacks, two-file-backed SQLite writer handles, concurrent replay and boundary tests, UTC rollover, downgrade, monthly weighted credit, and seeded 850k limit.

## One billable invocation, not HTTP/fan-out

The billable unit is **one accepted, first-party-authenticated hosted MCP root tool invocation** with a stable root invocation ID. `hosted-child` fan-out, `retry` of the same root ID, local Agent operations, raw HTTP handshakes, browser requests, P2P traffic and relay bytes are **not new logical billable invocations**. A network retry may still consume infrastructure rate limits, but must not run a mutation twice. Newly requested independent roots require fresh IDs. The server must generate or validate the canonical ID; a self-declared client ID must not reset allowances.

Credit policy is a **distinct** dimension: 1x ordinary and 5x special-skill weighted credits survive in the current monthly ledger until an explicitly approved policy version switches them. Daily counts must not accidentally replace existing paid/provider cost protections. The SQL candidate demonstrates all three counters in a single transaction, but is not running in live D1 Workers.

## Subscription and payment authority

**Four independent gates:** authenticated account/device/tenant + plan entitlement + positive provider settlement + quota admission. An operator cannot enable a plan solely by editing an account's `planId`, adding a subscription-shaped row, or passing a client `trustedPaidEntitlement` boolean. Signed webhook verification, verified transaction settlement, idempotent provider event processing, ownership continuity, ordered refund/cancellation updates, and a durable authorization snapshot need live integration *before* the staging proposal could be wired to request dispatch.

Existing `BillingService.entitlementActive` deliberately treats some `paused`/`past_due` and cancelled-with-grace states as active. This branch **does not change those production semantics**; its proposed S4 admission model is stricter. Differences require a named migration and commercial decision. The technical `paymentConfirmed` property is **only an input contract**, not evidence that current Lemon Squeezy callbacks already prove settlement.

For Enterprise, require separately validated organization membership/role, a tenant-owned subject, an active finite contract and paid authority. SQL denies a paid subject simultaneously assigned to another active tenant. Same tenant may pool approved seats with one subject, but device owner and per-command scopes still need individual verification.

## Display and consent record (candidate, not deployed)

Future plan selector must display, in Turkish, before any affirmative consent:

> Mevcut hizmette Free hesabın kullanım sınırı aylık 1.000 ağırlıklı kredidir. Gösterilen günlük kotalar henüz kullanıma açılmamış plan tasarımlarıdır. Ücretli paketler etkin değildir ve bu ekranda ödeme alınmaz. Sözleşme etkinleştirildiğinde günlük mantıksal çağrı sayısı, varsa 60 saniyelik hız sınırı, aylık ağırlıklı kredi sınırı, hizmet kapsamı, fiyat, yenileme, iptal ve iade koşulları ayrı ayrı görüntülenecektir. Tekrar denemeler ve iç görevler yeni bir ücretli çağrı sayılmayacaktır. Altyapı sağlayıcılarının ayrı sınırlamaları geçerlidir.

Required display contract for an eventual **approved** checkout:
- Current live entitlement versus *future proposal*, plan version/revision, canonical UTC reset, daily/minute and weighted monthly limits, effective period, any separate provider limits, price/currency/tax/recurrence, provider identity, cancellation/refund terms and document versions, with a visible no-cost / payment-paused state.
- Separate unchecked opt-ins for terms, price/recurrence, privacy notice and quota-contract acknowledgment; no prechecked controls or implied consent; offer expires and checkout fails closed on altered terms.
- Immutable audit receipt: authenticated account ID, tenant ID, grant/offer ID, nonce, terms SHA-256, terms version, locale, displayed price snapshot hash, opt-in flags, accepted timestamp, expiry, revoked timestamp, provider settlement reference *after verified confirmation*, entitlement revision and nonsecret correlation ID. Do not persist raw credentials or unnecessary device fingerprints. Minimize or hash IP with a reviewed retention policy.
- A receipt is **not** an active subscription or a payment: signed-provider confirmation and owner-approved activation are separate.

The code models the consent fields; real checkout, legal review, privacy retention and receipt persistence remain blocked.

## Safe migration and rollback contract

1. Remain on **live monthly Free** until owner authorization. Create a separate versioned D1 migration and backup before canary. Never run the dev fixture on production.
2. Freeze and map identities before plan transfer: `account -> tenant -> quota_subject -> devices`. Preserve historical usage, idempotency IDs and free-cluster linkage. Do not grant fresh Free credit by silently creating a different subject.
3. Project a provider-verified entitlement into an **atomic revision/CAS** grant. Revoke old revision before granting a new one. Downgrade below already-consumed daily/monthly allowance means no new admission; do not refund by decrementing counters or blindly replaying unknown mutations.
4. During transitional dual accounting, require both the old monthly weighted meter and new daily/minute meter to admit in a single transaction. Failure of either denies dispatch. For paid-to-Free downgrade, expire paid scopes first and ensure the final Free subject retains appropriate historical debits, with an audited transfer procedure.
5. Rollback uses the old deployed service and old monthly tables without deleting historical events. Fail closed on missing D1, incomplete archive, ambiguous reservation, failed provider settlement or inconsistent tenant/subject mapping. No free-user billing or provider auto-charge fallback.
6. Benchmark **real Cloudflare D1 multi-Worker concurrency**, CAS behavior, trigger support, partial/out-of-order webhooks, p95/p99, adversarial request replay, tenant crossing, provider downtime, retention/cost before any real cutover.

## Commands and known limitations

```sh
npm run typecheck
npm run build
node --test --import tsx test/subscription-entitlements-v2.test.ts test/v2-quota-d1-staging.test.ts
npm test
```

**Not claimed:** real-money validation, production billing, provider-confirmed settlement, live D1 Workers consistency, deployment, real Enterprise purchase, real tenant membership persistence, 850k completed calls, load acceptance, monthly-to-daily cutover, or remote device modifications. Local `node:sqlite` tests use SQLite WAL with two file handles in one process. Live Cloudflare transactions and compliance approvals remain separate **NO-GO** gates.

## Hardened safety invariants (follow-up to PR #554)

The S4 contract now explicitly binds a verified paid subscription to the **exact provider subscription ID and catalog variant ID** from the owner-maintained offer. An active subscription for another variant or account is not a paid quota entitlement. Identity records include server-resolved `quotaSubjectKind`: Free must use `free-cluster`, paid Plus/Pro/Enterprise must use `subscription` (prepaid Enterprise is **not implemented** by this fixture). The SQLite trigger independently verifies subject kind before any credit mutation.

Each admitted root reserves a canonical lowercase **SHA-256 request fingerprint** of the server-owned root action, target and normalized arguments. The stable invocation ID and fingerprint are both required. A repeated ID with the same account/tenant/device and payload hash returns `duplicate`, while reuse with a different actor, device or fingerprint returns `conflict`. **Neither authorizes dispatch**, regardless of whether the original call succeeded; operation-result recovery belongs to the separate reconciliation contract. Store only the digest, not tool arguments, secrets or request JSON. Hash canonicalization and idempotency-key issuer authentication must be production-reviewed.

`v2_quota_authority` now forbids same/lower revision updates, in-place subject/tenant reassignment, and row deletion; revocation and reactivation require strictly advancing epochs. This protects against accidental stale grant restoration within the staging DB. Grant issuance remains a privileged projection from authenticated account, plan, payment and consent stores; direct SQL insertion from external clients is **never allowed**. Database-owner compromise, backup restores and cross-database migrations still require out-of-band protections.

Additional file-backed SQLite tests cover provider variant theft, Free/paid quota subject confusion, lost database write acknowledgements after commit, fingerprint collisions, revision regression and forbidden authority deletion. Local tests cannot establish guarantees for Cloudflare D1 rollback/trigger semantics across multiple deployed Worker isolates, or external provider billing identities. These remain deployment blockers.

**Note:** Revenue settlement is deliberately not performed here. The `paymentConfirmed` property represents evidence consumed by a future *trusted* reconciler, not a boolean that clients or dashboard forms may post. Before a paid launch, validate signed and ordered webhooks, settlement and refund finality, tied account/provider IDs, encrypted and auditable consent receipts, and an explicit approval gate.

## 2026-10-18 multi-process staging acceptance addendum

The evidence below was obtained after reconciling PR #561 with the then-current `origin/main`. No paid or production services were modified. It adds `test/fixtures/v2-quota-process-worker.ts` and `test/v2-quota-multi-process-staging.test.ts`.

**Actual test topology:** each writer is a separate Windows Node 22 operating-system process with its own SQLite handle and WAL connection to one disposable file-backed database under the OS temporary directory. A start barrier releases competing writers together. Every writer executes the staging D1-compatible insert+triggers through the existing `D1DatabaseLike` interface. The harness removes its own disposable database and only terminates subprocesses it created. This is more realistic than two handles in one process, **but it is still SQLite, not a live Cloudflare D1 service or independently deployed Cloudflare Worker isolates**.

| Staging check | Observed result | What it proves |
| --- | --- | --- |
| Free, Plus, Pro, Enterprise sent simultaneously from four processes | Four separate subject ledgers, each 12 accepted logical invocations and 28 weighted monthly credits | Four isolated synthetic accounts do not debit one another; Free monthly weight 1x/5x is preserved in the fixture |
| Eight competing processes, shared enterprise subject, 720 unique root invocations at one trusted timestamp, 600/rolling minute | Exactly 600 `reserved`, 120 `minute-exhausted`; all three counters record 600, with no partial rejected charge | Single-file SQLite trigger under multi-process writer contention does not over-admit beyond 600 for that subject |
| A new root after the rolling 60-second window, across UTC midnight | `reserved` without resetting monthly usage; next UTC day's daily counter is separate | Counter boundaries do not accidentally reset rolling-window limits |
| Same root ID, different SHA-256 payload fingerprint, sent concurrently from independent processes | One `reserved`, one `conflict`; exactly one debit | Duplicate-ID payload conflict does not execute or charge twice |
| Wrong-owner synthetic device supplied to another account | `revoked`, zero charge to victim; legitimate owner call `reserved` | SQL checks device ownership even when the reservation object was forged |
| Revoked paid entitlement epoch reused by four distinct processes | All `revoked`; SQL rejects lowering revision to restore permissions | Source-level revocation admission gate remains fail closed across independent SQLite writer processes |
| An `ACTIVE` label with missing settlement, `CANCELED` or `PAST_DUE`, or cancelled provider record with future `endsAt` | Denied by candidate entitlement resolver | A status label or nominal grace period cannot grant this stricter proposed paid right alone |

**Boundary:** the source fixture enforces 600 per rolling 60 seconds **per quota subject**; it is not the ingress-wide, per-tunnel + application shared OpenAI transport cap. Provider limits count discovery, retries and rejected transport requests too. An ingress-wide provider limiter is separate and mandatory; the source meter must never be advertised as satisfying provider-wide 600/min.

### Unverified, release-blocking real D1 acceptance

No authorized remote Cloudflare D1 staging database ID, API token or deployment target was available in this execution environment. `cloudflare/wrangler.jsonc` still contains the literal placeholder `REPLACE_WITH_D1_DATABASE_ID`. The test therefore did not access a production or customer D1 database and did **not** deploy Worker routes. Real D1 confirmation requires an owner-authorized **isolated staging** database, real independent Worker isolates, test-only identities, negative 600/min burst, concurrent same-ID/content mismatch, expired/revoked grant and wrong-device ingress, plus D1 query/cost and backend-failure instrumentation. Do not run this fixture on live D1 or transfer results from SQLite to Cloudflare as production PASS.

### Source acceptance versus production entitlements

**Source acceptance:** the non-live proposal compiles, DB tests use actual disposable WAL transactions and enforce the checked race, replay, account partitioning and epoch behavior. Local source-level `paymentConfirmed` evidence is a modeled trusted input, **not** a real verified settlement record, cryptographic proof, payment receipt or ready production entitlement. Verified signature, provider subscription/variant/owner reconciliation, ordered cancellation/refund webhook processing and actual financial settlement must be implemented in a separately approved component before rollout. Current production billing can treat some paused or past-due states as active in its own older policy; the proposed stricter gate does not automatically change that policy.

**Production entitlement acceptance: NO-GO.** The live Free-only allowance remains 1,000 **weighted credits per UTC month** (including existing verified repository-owner exception). Future 1,000/5,000/10,000 accepted roots per UTC day are NOT enabled. Enterprise 850,000/day and 600/min were exercised only as fictional limits in isolated tests, not as guaranteed real-provider throughput, a paid tier or an invoiceable quota.
