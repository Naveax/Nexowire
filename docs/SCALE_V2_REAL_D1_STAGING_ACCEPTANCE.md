# Scale v2: real Cloudflare D1 staging preflight / distributed acceptance

**19 October 2026 | Source: PRs #554, #561, #566 MERGED | Remote D1: BLOCKED.**

This is a staging **admission and read-only schema gate**, not a deployment tool.
No existing quota or billing implementation has been modified. Never turn on daily
plan entitlements, create a paid subscription, dispatch a real tool, or run migration
against the existing `nexowire-control-plane` production database.

## Provenance matrix

| Dimension | Status | Evidence |
|---|---|---|
| Existing source quota engine and SQLite WAL competition | SOURCE_TESTED | Prior #554/#561/#566 tests; 8 local OS writers, 720 attempts, 600 admitted, 120 denied |
| Remote Cloudflare D1 identity | BLOCKED | No authorized staging account, dedicated D1 ID, or read-only D1 token on Naveax / work-pc |
| Remote D1 table/trigger validity | NOT_TESTED | Requires isolated staging database and an authenticated read-only schema probe |
| Genuine Workers/D1 concurrent inserts | NOT_TESTED | Separate remote Worker instances/endpoints plus authoritative D1 required; local Wrangler and REST SELECT do not prove this |
| Wrong tenant/owner/device and replay over real Worker ingress | NOT_TESTED | Staging-only first-party identity binding and signed proof must be supplied by backend |
| Real provider payment settlement and revocation | BLOCKED | No test issuer or signed staging payment evidence; mock booleans are not settlements |
| Production entitlement rollout | NO_GO | Billing remains paused; Free monthly policy stays as-is |
| Cloudflare actual resource costs / 24h throughput | NOT_TESTED | No authorized paid infrastructure/test budget and no D1/Workers metrics |

**Cloudflare distinctions:** `wrangler dev` with its default bindings
uses local simulation, not a live D1 service. D1 Sessions/read-replication
changes query-consistency assumptions; do not infer distributed serializability
from two local SQLite handles or one REST read. Test actual target Worker
requests and authoritative D1 admission records before changing status.

## Read-only preflight, fail closed

The operator must independently provision **an isolated staging-only D1** named
`nexowire-scale-v2-staging-<identifier>`, grant a *D1 Read* scoped API token
for that account, and separately authorize its use. Never substitute the
existing production database, production Cloudflare token or production deploy
workflow.

Environment fields (values must stay in a local secret manager, never Git/logs):

```text
NEXOWIRE_CF_STAGING_APPROVAL=ISOLATED_D1_READ_ONLY
NEXOWIRE_CF_STAGING_ACCOUNT_ID=<32-character Cloudflare account ID>
NEXOWIRE_CF_STAGING_DATABASE_ID=<staging D1 UUID>
NEXOWIRE_CF_STAGING_DATABASE_NAME=nexowire-scale-v2-staging-acceptance
NEXOWIRE_CF_STAGING_WORKER_URL=https://nexowire-scale-v2-staging-acceptance.example.workers.dev/
NEXOWIRE_CF_STAGING_READ_TOKEN=<dedicated least-privilege D1 Read token>
```

To validate required parameters without network access:

```sh
node --import tsx scripts/check-scale-v2-d1-staging.ts
```

To query **only a verified remote staging database**, with *no mutations*:

```sh
node --import tsx scripts/check-scale-v2-d1-staging.ts --probe
```

The CLI always exits with status 2: `BLOCKED` when missing/invalid and also
after a successful read-only schema observation, because **distributed
acceptance remains incomplete**. When approved and configured it checks the
Cloudflare D1 metadata (UUID and exact database name) before running a
fixed `SELECT name FROM sqlite_master...` query. No SQL input is accepted.
It does not call the Worker URL, create tables, add accounts, or emit tokens.

Existing repo `cloudflare/wrangler.jsonc` points to the production database
name and contains an ID placeholder; therefore it is **not** a staging deploy
configuration. The existing workflow `deploy-control-plane.yml` is explicitly
production. This PR does not add a writable remote migration or deployment
command.

## Real remote acceptance sequence: separate future authorization

After owner-approved credentials, an isolated staging Worker build, and a
controlled fixture D1 are available:

1. Confirm account, D1 ID/name and Worker hostname from separate trusted sources;
   refuse any production overlap. Verify the Worker runs only in the isolated
   staging environment and uses only the dedicated staging D1 binding.
2. Apply fixture schemas to **staging only**, with an independent signed
   migration review and rollback. Do not reuse production `accounts` or billing
   records, payment provider secrets, real owner device tokens, or any live
   identity. Keep all plans OFF outside the test Worker.
3. Through **at least two separate deployed Worker instances**, send bounded
   concurrent unique root invocations and identical IDs with different
   normalized SHA-256 payload hashes. Verify one durable reservation, correct
   `duplicate/conflict` behavior and consistent server-side D1 metrics.
4. Inject wrong owner/device/tenant grants and stale entitlement epochs and
   verify rejection **before dispatch** with unchanged subject/day/month usage.
   Revoke a signed test subscription; check both prior and newly started Worker
   isolates fail closed. Invalid or missing settlement evidence must never mint
   Plus/Pro/Enterprise rights.
5. Test exact UTC rollover and rolling 60-second windows separately. Under a
   bounded <=720-request synthetic burst, at most 600 are admitted for a
   600/min **quota-subject** contract, and 0 beyond the active cap. Observe D1
   `rows_read`, `rows_written`, timeouts, errors, throttling, p95/p99 latency
   and cross-Worker causality. This does **not** replace the shared provider
   ingress-wide tunnel+application 600/min budget; denied/metadata/retries count
   against that other limit.
6. Reconcile authorization and reservation ledgers against every request ID;
   ambiguous outcomes remain `UNKNOWN` and must not dispatch or replay a
   mutation. Test corrupted snapshots, old backups and entitlement revision
   rollback with a trusted monotonic authority.
7. Record actual Cloudflare Workers and D1 billing/usage metrics and any
   approved cost envelope before claiming cost acceptance. A 850,000/day
   contractual ceiling is not verified completion throughput or zero cost.
8. Release and billing remain **NO_GO** until independent signed-payment
   verification, durable consent/price/terms receipts, tenant ownership,
   incident rollback and a bounded 24-hour distributed soak have passed.

## Policy boundary (must not change)

Current live **Free: 1,000 weighted credits per UTC month** (ordinary 1x,
special skills 5x; existing verified owner exception). Proposed
**Free 1,000 / Plus 5,000 / Pro 10,000 logical calls per UTC day** and
Enterprise/Custom finite contract are disabled, not new deployed features.
`PAST_DUE` and `CANCELED` are denied by the dormant entitlement candidate
but existing deployed billing semantics are not changed here. No real payment,
invoice, checkout, charge, refund, subscription activation, or live capacity
configuration is authorized by this acceptance project.

**Latest outcome:** SOURCE preflight logic tested; REAL DISTRIBUTED D1 STAGING
`BLOCKED`; PRODUCTION ENTITLEMENTS `NO_GO`; REAL COST `NOT_TESTED`.
