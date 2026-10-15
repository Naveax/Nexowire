# S2 historical hosted-MCP replay cutover fence (STAGING ONLY)

**2026-10-15 / issue #484 / parent #482.** This is a proposal and an offline SQLite proof, **not** an approved Cloudflare production migration. It stacks on the #500 DEV admission wrapper and #499 atomic dual-quota ledger.

## The actual gap

The old monthly `quota_usage_events` unique key is `(quota_subject_id, period_key, event_id)`. A legacy event ID from a different UTC month can therefore be inserted again when the old charge path or a new dual path is used. The new `dual_quota_reservations` table has a durable per-subject key, but that alone cannot cover **existing pre-cutover monthly events** or **quota-subject changes**.

The file `test/fixtures/scale-v2-global-replay-cutover-staging.sql` creates an **event-ID-global** `mcp_global_replay_fence` and backfills canonical 68-character `mcp-` SHA-256 event IDs from the actual old monthly ledger, plus daily-only S2 events that have no matching monthly event. A duplicate recorded across historical UTC months or subjects makes the backfill **fail closed**. Do not silently `INSERT OR IGNORE` ambiguous historical repeated operations.

After the backfill, a nested `AFTER INSERT` trigger reserves a global event ID for each new dual admission. The original daily + monthly trigger must also complete inside that **same top-level SQL INSERT**. Any failed global uniqueness check rolls back both quota changes and the parent reservation. Two `BEFORE INSERT` triggers prevent a new canonical hosted MCP event from being added through either separate monthly-only or daily-only ledger once this cutover fixture is installed. The dual parent exists before its nested writer calls, permitting only that combined operation.

**Critical order in a future explicitly authorized cutover:** disable/quiesce every old hosted MCP mutation writer **before** taking a consistent database snapshot; verify canonical identity and completeness of all legacy records, inspect duplicates, install the backfill and the blocking triggers **inside one transaction**; verify exact server version/Worker route and rollback, then (separately) allow signed canary traffic. The DEV test runs the SQL inside `BEGIN`/`COMMIT` and verifies full rollback if backfill finds duplicates. Actual D1 migration transaction behavior must be tested independently, and no migration is authorized here.

## Local negative/positive proof

`test/global-replay-cutover-staging.test.ts` applies the real base SQLite schema and the earlier daily/dual STAGING fixtures into disposable file-backed SQLite. The eight tests cover:

- A previously accepted September monthly-only MCP event attempted through the October dual route: denied before second execution; both ledgers unchanged.
- A new atomic dual request accepted once with one global fence entry; same event replayed under a **different quota subject** denied without extra charge.
- Canonical MCP events newly entered through monthly-only or daily-only paths: rejected.
- Duplicate old event ID recorded in two UTC months: transactional cutover aborts rather than guessing which command executed.
- Daily-only historical event backfill, and legitimate historical monthly + daily pair deduplicated exactly once.
- Noncanonical new event ID refused; no partial daily/monthly credits.

**Result:** 8/8 DEV SQLite tests PASS; TypeScript PASS. This proves only local SQLite trigger/transaction semantics, not Cloudflare D1 provider behavior or live MCP execution.

## Blocking limitations

1. A canonical `mcp-` event hash is inferred from the current first-party `hostedMcpUsageEventId`. Historical noncanonical IDs, missing records, deleted/expired retention data or a previous account/subject migration are **not** automatically reconstructed; any unaccounted mutation history blocks activation.
2. The fence is an eventual proposed production data dependency, but the file remains **under `test/fixtures`**, not `cloudflare/migrations`. Production D1 schema, payment, new quotas, feature flags and Agents remain untouched.
3. Parallel old Worker deployments, pre-cutover in-flight tool executions, OAuth/role/device revocation races, client-created invocation IDs and stale Hub versions must be rejected under a single exclusive server admission/execution barrier. SQL alone cannot prove this boundary.
4. Actual D1 concurrent Workers, transaction error mapping, `meta.changes`, billed read/write rows, cost budget, backups and rollback require a separately owner-approved Cloudflare staging canary before a rollout proposal.
5. A unique ID prevents exact replay only when every mutating tool uses a stable canonical ID; it is not a general-purpose exactly-once guarantee for all possible side effects.

**No-go:** Never use this staging fixture to automatically promote a production migration or enable a dual charge in a live Worker.
