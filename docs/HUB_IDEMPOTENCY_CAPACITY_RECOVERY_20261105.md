# Hub IDempotency: SQLite migration, no artificial record limit

**Observed incident (2026-11-05):** Work-PC Hub v1.0.8 was refusing file-write
reservations after its JSON idempotency store reached exactly **2,000/2,000**
records (1,958 succeeded, 38 failed, 4 unknown). A different, stale 80-entry
journal on NAVEAX was not the active Hub. Source root cause was the hard
`maxRecords=2000` default in `src/operations/idempotency-store.ts`.

## Solution

The default production Hub idempotency store is now **SQLite WAL** with
`synchronous=FULL`. It has **no app-level count ceiling**. A constructor
`maxRecords` option remains only for existing bounded fault-injection tests
and is not passed by `src/runtime.ts`.

- Existing legacy v1 `idempotency-records.json` records are migrated using
  a single transaction. Historical key, operation UUID, fingerprint, device
  and status are preserved. Legacy JSON is kept untouched as an audit/backup.
- A legacy-file SHA256 marker detects a changed/appearing v1 journal on
  startup, blocking accidental old/new Hub dual-writer reconciliation.
- `in_progress` left after restart becomes `unknown`; neither `unknown`
  nor completed keys are silently pruned. Reused key+different fingerprint is
  denied; reusing the same key returns its original operation identity.
- SQLite uses indexed durable lookups; metadata-only results, not request
  payloads, secrets or tool content, are persisted. A 256-result in-memory
  cache bounds response memory and does not retire idempotency tombstones.
- SQLite insertion/disk-full/lock/corruption failure prevents reservation
  completion. It does not downgrade the execution fence.
- Native `files.write` remains available. The **artificial Hub count quota**
  is removed; valid new user operations are permitted as long as durable
  storage can commit them.

**"Unlimited" means no configured 2,000/5,000 record limit**, not infinite
physical disk, RAM, file-size or filesystem capacity. Disk exhaustion must
still fail closed rather than acknowledge an unrecorded mutation.

## Exact evidence

- GitHub PR #1086 source HEAD at initial SQLite migration:
  `d7b0fb00ceb6703579abbf1c2f892ccee291baf7`.
- GitHub CI `42030219741`: Linux Node 22/24 PASS, local-app safety
  and migration unit tests PASS; browser-live tracked independently.
- Disposable **Work-PC** build environment: TypeScript check, build and
  **21/21 targeted tests PASS**. It uses an isolated staging directory,
  never the production journal.
- A real snapshot of the Work-PC 2,000-entry journal was migrated in a
  private staging directory, retaining **1,958 succeeded/38 failed/4 unknown**.
  Original JSON hash remained unchanged. The 2,001st synthetic reservation
  succeeded; a duplicate returned the same operationId and mismatched
  fingerprint was rejected.
- Controlled **Work-PC Hub-only** cutover: existing app and launcher preserved,
  separate patched app directory activated through the existing Hub scheduled
  task. Other Nexowire Native Agent and Privileged Broker tasks were not
  restarted. Loopback port 43110 returned online with the patched Hub PID.
- Live production SQLite readback immediately after migration: 2,000 entries,
  historical status distribution retained, original JSON SHA unchanged.
- A genuine Nexowire `file_write` to NAVEAX using a **separate disposable
  test file** completed: Work-PC Hub's SQLite ledger advanced to **2,001**
  and recorded the exact test key as `succeeded`. Repeating the same request
  key returned the same requestId (no second dispatch). The disposable file
  was deleted afterward.
- The user's original `naveax-reply-guard.js` content was not supplied to this
  hotfix and **was not written**. Its initial key was absent from the live
  legacy journal prior to this repair.

## Operational notes

1. Keep the original JSON, its `.pre-sqlite-20261105` snapshot and the
   original launch script backup. They should remain protected with existing
   filesystem ACLs; do not print or upload credential-bearing scripts.
2. The patch is side-by-side under the Hub-only app directory
   `1.0.8-a19a228dc6f1-idempotency-sqlite-hotfix`. The user Hub task alone
   points to this app. The Native Agent and Broker stay on the original
   version path.
3. **Do not roll back the Hub binary to a JSON-only 2,000-entry reader after
   new operations are committed.** Such a downgrade would lose visibility
   of new SQLite tombstones. Recovery requires a compatible SQLite reader
   and the complete `.sqlite`, `-wal`, `-shm` journal set.
4. Do not remove SQLite tombstones to reclaim disk; disk is finite and
   invalid/corrupt records must be treated as a blocking incident.
5. Follow-up engineering: test interrupted/crashed migration and concurrent
   old/new Hub ownership under fault injection, plus Windows package/upgrade
   acceptance. The hotfix should remain in Draft until full CI/review is
   complete; production field fix and source merge are distinct events.

**Outcome:** artificial idempotency capacity blockage fixed on Work-PC,
and `file_write` verified end-to-end in the actual Hub/Agent path.
