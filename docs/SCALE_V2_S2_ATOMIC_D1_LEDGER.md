# Scale v2 S2: Atomic D1 daily logical invocation ledger (DEV fixture only)

> **Implementation is offline/DEV-only, not wired to production Worker, Hub, ControlPlaneService, or billing.** Parent [S2 #484](https://github.com/Naveax/Nexowire/issues/484) and [master #482](https://github.com/Naveax/Nexowire/issues/482). Complements the proposed Free 1,000 / Plus 5,000 / Pro 10,000 logical requests/day simulator in `docs/SCALE_V2_S2_DAILY_QUOTA_PROPOSAL.md`.

## Structure and authoritative requirements

`test/fixtures/scale-v2-daily-requests-staging.sql` holds an **additive D1-compatible SQLite schema fixture** deliberately outside `cloudflare/migrations/`. Nothing auto-applies the schema to live D1. It contains:

- `daily_request_periods`: one integer logical-invocation counter per **quota subject** and UTC calendar day. Existing monthly `quota_usage_*` and weighted-credit ledger are untouched.
- `daily_request_invocations`: one stable, bounded invocation identifier per quota subject, with a primary key **without the UTC day**. Thus reusing the same ID after midnight is a duplicate, not a second paid/free execution.
- A `BEFORE INSERT` trigger that initializes the day counter, checks it against `daily_limit`, and increments it **as part of the same single SQL INSERT statement**. When the limit is exhausted, the statement aborts and the trigger's partial counter mutation rolls back. The uniqueness constraint prevents replay.

`src/product/daily-request-d1-ledger.ts` exports `DailyRequestD1Ledger.reserve(...)`. It validates bounded input, uses an existing D1 `prepare().bind().run()` abstraction and interprets `reserved`, `duplicate`, and `exhausted` outcomes. Real database/network errors propagate and **must never authorize an MCP tool**. It treats an ambiguous committed invocation found after a write error as duplicate, not safe-to-retry success. It requires a non-zero confirmed row-change count but does not assume trigger-affected rows are counted identically by every provider.

The caller is trusted to supply `quotaSubjectId` and `trustedDailyLimit` resolved from current authenticated account/organization entitlements. **No MCP JSON field, user client, self-declared tier, browser request or local Agent may set those trusted values.** There is no active code path to this ledger in the production app.

## Local proof and strict limitations

`test/daily-request-d1-ledger.test.ts` applies current base migrations into a disposable **file-backed SQLite database** and loads only the staging fixture. Tests use **two separately opened SQLite database connections**:

- Free 1,000 distinct accepted calls and 1,001st denied with no extra event.
- 999-to-1,000 boundary: 12 distinct concurrent requests, exactly 1 accepted and 11 rejected by the single-statement SQL trigger.
- Same invocation ID attempted 16 times through two connections, exactly 1 accepted and 15 duplicates.
- UTC day rollover permits a new ID but does not permit a prior ID; another account's identical ID has an independent quota subject.
- Plan downgrade blocks any new invocation once usage exceeds the revised cap; upgrade permits use up to revised cap, assuming limits came from trusted server policy.
- No changes whatsoever to the original monthly `quota_usage_events` table, plus fail-closed response on unknown D1 failures.

These **are not real Cloudflare multi-Worker transactions**: local SQLite connections run in one Node process and cannot demonstrate provider contention, p95 latency, D1 rows read/written billed, retry under network partitions, or Cloudflare daily request budget. Provider-specific trigger and `D1ResultMetaLike` compatibility must be verified in a controlled staging instance before production planning.

## Open security and product gates

- [ ] Resolve subscription and quota-subject authorization on the server; verify paid Plus/Pro and finite Enterprise contracts, never accept a client-supplied limit or identity.
- [ ] Design a coordinated **atomic dual-charge or reservation policy** with existing monthly weighted credits during migration. Merely making the new daily ledger work does not safely replace `ControlPlaneService.chargeUsage`.
- [ ] Determine approved, privacy-conscious replay-ID storage and retention across UTC periods and rollback, especially for mutating tools.
- [ ] Prove provider-specific D1 transactional trigger semantics, simultaneous independent Worker admissions and ambiguous write failures in owner-approved staging.
- [ ] Meter Worker requests/D1 rows and support a fail-closed shared free-tier cost envelope. No zero-cost unlimited capacity claims.
- [ ] Add full owner-authorized token-family revocation, safe account/device permissions and staged rollback before any live release.
- [ ] Only after reviews, create a **separate explicit versioned production migration**, canary flag, backup/rollback plan and deployment approval.

## DEV verification

```sh
node --test --import tsx test/daily-request-d1-ledger.test.ts test/daily-quota-proposal.test.ts test/quota-subject-d1.test.ts test/fused-mcp-client-server-contract.test.ts
npm run typecheck
npm run build
npm run continuation:check
npm run ai-screen:launch-audit
```

No existing Nexowire Agent, privileged broker, cloud deployment, subscription or quota setting is modified by these files.
