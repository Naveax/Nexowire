# Scale v2 quota #14 | Streaming cancel / epoch gates for #588 and #596

## Scope of actual change

**Staging-only:** extension to `StagingArtifactByteBudget` and isolated two-writer SQLite tests. No production Worker, live Agent, pricing, subscription activation, D1 schema, MCP payload size, Artifact Bridge store or ProcessManager changes. The active Free policy remains **1,000 weighted credits per UTC month**; future Free 1,000, Plus 5,000 and Pro 10,000 requests/day remain dormant.

### Newly closed staging gap: cancel race and durable storage reservation

- `requestCancel` records `CANCEL_PENDING` as a durable SQLite tombstone **only for the trusted owner, device, project and expected current offset**. Repeated matching cancels are idempotent; a changed offset is rejected, and a foreign principal cannot cancel the transfer.
- A session in `CANCEL_PENDING` accepts **no new or replayed chunk stages, no late commit receipt, no final publication**. Existing byte-admission entries are not deleted, refunded or billed twice merely because a cancellation occurred; the sliding window keeps accounting for admitted traffic.
- The declared whole-file storage reservation stays charged while cleanup is uncertain. `acknowledgeDeletion` accepts cleanup of a cancelled session **only after the trusted #08 adapter has both a verified physical deletion receipt and a verified in-flight writer fence** (`durableDeletionVerified`, `writersStoppedVerified`). Without this fence it throws `WRITER_FENCE_REQUIRED`, preserving reservation. This is **an API contract for a future trusted integration**, not authentication achieved through client-submitted booleans.
- A cancelled root cannot restart using the same invocation/session key. Completed objects still use the existing independently verified deletion path. Another authenticated owner can continue using its own byte/storage allowance when an unrelated owner cancels.
- The server must stop/fence every outstanding OS writer, reconcile UNKNOWN state and verify deletion against the same immutable store epoch before supplying the trusted fence/deletion receipt. A boolean supplied in user JSON **MUST NEVER** be passed through directly. Disk-full, writer crash and cancellation midway through a physical store write remain **BLOCKED** without #08/#05 integration.

### Current main quota and D1 source invariants checked

- `src/product/plans.ts`: Free `monthlyCredits: 1_000`. `docs/FREE_ONLY_POLICY.md` documents UTC-monthly weighted credits with 5x special-skill weight; paid billing is paused by default, and the verified repo-owner exception is a separately trusted mapping.
- `src/product/v2-quota-d1-staging.ts`: one insert plus SQLite fixture triggers for atomic minute/day/monthly deductions, identity/tenant/device/revision checks, same invocation ID + different SHA-256 fingerprint -> conflict, ambiguous ACK -> no dispatch. This is **not** a production D1 migration.
- Existing `test/v2-quota-d1-staging.test.ts` and `test/v2-quota-multi-process-staging.test.ts` already exercise rollback, UTC, revoked/stale epoch, wrong owner/device, 600 vs 720 admissions and independent Free/Plus/Pro/Enterprise sandbox ledgers. The existing cases were **not reimplemented**.
- The local byte ledger is a separate accounting lane: traffic and reserved disk bytes must **not** be represented as actual paid tool calls; logical root credit charging needs an independent idempotent entitlement and verified execution receipt. A single upload must not become thousands of new billable MCP tool invocations.
- Provider MCP tunnel ingress/serialization constraints are still enforced separately. Each chunk remains bounded at **65,536 bytes**. No unlimited MCP body, giant in-memory stream, per-user tunnel multiplication or provider rate bypass was introduced.

## Acceptance levels

| Layer | Status | Grounded evidence / blocker |
| --- | --- | --- |
| Source cancel/fencing negative tests | Local PASS | Independent file-backed SQLite WAL writers, idempotent cancel/receipt/offset and owner isolation |
| Source V2 quota D1 tests | Local PASS when run | Existing fixtures include atomic minute/month/UTC/replay/revocation |
| Remote Cloudflare Workers/D1 | **BLOCKED** | No owner-authorized isolated staging account, D1 ID, scoped token or approved Worker endpoint found on either Naveax or work-pc |
| #588/#596 real cross-device streaming | **NOT_TESTED** | No Artifact Bridge/Agent/Hub physical transfer or trusted cancellation writer barrier wired in this PR |
| Real bandwidth, storage retention and Cloudflare cost | **NOT_TESTED** | No cloud deployment, actual long transfer, storage receipts or cost metrics |
| Production billing/entitlements | **NO-GO** | Live Free 1,000 weighted credits/UTC month unchanged. Future daily plans OFF. No payment, invoice, subscription or production D1 mutation |

**Release rule:** A green GitHub source CI does not change Cloudflare acceptance to PASS. Keep this DRAFT while integration owners #08 (store), #05 (filesystem), #06 (reconnect), and #16 (QA) validate real trusted receipts, writer-fence provenance, physical disk free-space/backpressure, crash/restart, retention and multi-tenant concurrency.
