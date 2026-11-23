# NX AI-04 | WAL and PID incarnation | 2026-11-23

## Source ownership and starting evidence
- Integration Draft PR: #1160; exact starting HEAD: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`.
- Relevant open incidents: #974 (SQLite WAL RESTART/reuse), #1001 (PID liveness is not incarnation).
- This agent may edit only `src/agent/operation-journal.ts`, `src/agent/operation-journal-wal.ts`, `src/agent/journal-owner-process.ts`, `src/agent/operation-journal-authority.ts`, matching journal/WAL/owner tests, and `docs/coord/NX_AI04_*.md`.
- Shared `src/agent/native-agent-lifecycle.ts` and GitHub workflow/provenance files have not been changed.
- Initial parent integration checks all completed successfully, including AI-04 run `45178025175` and general CI `45178026197` on HEAD `83c8b65`.
- Initial AI-04 Draft PR #1245 `2404470` failed CI run `45181788589` in two coordinator provenance tests, because a previously inventoried root-level test blob had changed (`b97249d` to `c20586a`). This branch restores that file to the exact previously inventoried blob and moves the additional tests into a separately tracked one-level fixture; source/provenance CSVs remain untouched. No active run is manually re-dispatched.

## Source review: invariants currently present
1. `verifyAgentJournalWal()` validates WAL header/page size/checksum and each **current-generation** frame checksum. A current-generation nonempty sequence must end on a committed frame. Retained older physical allocation after a SQLite RESTART is recognized only after a committed prefix and a stable WAL-index corroboration. The two WAL-index header copies, salts, mxFrame and checksum are checked.
2. The journal validates WAL before SQLite opens it; it refuses ambiguous WAL/SHM replacement and does not automatically checkpoint, VACUUM, delete or replay records.
3. `readJournalOwnerProcess()` provides Windows process creation FILETIME or Linux boot ID + start tick where available. Under `BEGIN IMMEDIATE`, journal owner snapshots are re-read; live/unknown/legacy identity blocks takeover. Only confirmed death or same-OS incarnation mismatch permits reclaim. Prior `in_progress` rows become durable `unknown`; terminal rows remain tombstones.
4. The startup Agent can retain read-only connectivity without eagerly taking the journal mutation lease. A trusted external CAS is still required before executor admission. A connected WebSocket alone does not prove mutating CORE authority.
5. A volatile SHM WAL-index is not an authenticity/anti-rollback authority. Independently trusted reservation history and a guarded ownership/ACL boundary remain necessary.

## Additional regression added on this branch
`test/agent/ai04-external-journal-owner.test.ts` (new one-level test; the existing root-level `test/agent-journal-owner-incarnation.test.ts` is preserved exactly to honor locked provenance):
- Spawn a real disposable Node process and observe its OS incarnation. Keep it alive while a different journal instance attempts takeover; assert `AGENT_JOURNAL_IN_USE` and unchanged `in_progress` status.
- Terminate that disposable process, confirm the subsequent takeover, require that interrupted `in_progress` becomes `unknown`, and refuse to recreate the same request ID.
- Reject malformed nonce and forged-but-unrecognized process incarnation while the PID is still alive; retain a committed tombstone.

These tests use only temporary SQLite files and a disposable child process; **no Work-PC production state is touched**.

### Reproducible source test commands

```powershell
node --version
npm ci
node --test --import tsx test/agent/ai04-external-journal-owner.test.ts
node --test --import tsx test/agent-journal-owner-incarnation.test.ts
node --test --import tsx test/qa-journal-wal-recycle-p11.test.ts
node --test --import tsx test/agent-journal-restart-regression.test.ts
npm run typecheck
```

Record executable Node major version, OS build, exact commit SHA and exit code with each run. The new one-level test is discovered by `test/**/*.test.ts` on the Linux CI shell, whereas root-level `test/*.test.ts` files still require explicit invocation. Confirm execution receipts rather than assuming. Do not equate a generic `npm test` success with execution of all targeted files.

## Fault-injection / acceptance matrix

| Scenario | Acceptance | Required observation |
|---|---|---|
| Current-generation WAL payload corruption | Source regression exists | `AGENT_JOURNAL_WAL_CORRUPT`, no file mutation |
| Valid RESTART/reused old allocation suffix | Source regression exists | Accept, preserve rows and UNKNOWN tombstones |
| Recycled tail with absent/disagreeing SHM index | Source regression exists | Deny, no repair |
| Current commit disguised as an older salt | Source regression exists | Deny, WAL-only UNKNOWN cannot disappear |
| Multiple retained WAL generations | Source regression exists | Accept valid monotonic allocation generations |
| Live external process owns journal | New test, run required | Deny takeover, no in-progress reconciliation |
| Confirmed external process exit | New test, run required | Claim lease, in-progress -> UNKNOWN, no replay |
| Malformed/forged owner metadata, live PID | New test, run required | Deny takeover, preserve records |
| Access denied to OS process birth metadata | Physical/VM NOT_RUN | Unknown identity cannot grant mutation lease |
| Cross-user SID / Windows elevation boundary | Physical/VM NOT_RUN | Only trusted owner identity; deny otherwise |
| Reboot #1 and #2 on a packaged Windows 1.0.8 profile | AI-09 NOT_RUN | Exact packaged binaries, owner readback and Agent startup |
| WAL RESTART/recycle #1 and #2 on disposable Windows clone | AI-09 NOT_RUN | No false refusal, unchanged request history |
| SQLite `SQLITE_FULL` / `READONLY` / crash while owner changes | Disposable VM NOT_RUN | No blind retry or journal repair |

## AI-09-only physical Windows handoff
This is a **runbook to hand off**, not approval to run it on a user's live device.

1. Bind app version, commit SHA, exact task names, executable path, Windows build and user SID in a read-only inventory. Confirm an independent, tamper-evident backup and hashes of DB/WAL/SHM before any operation.
2. On an isolated clone (not the user profile), run strict WAL verification and `PRAGMA quick_check` readback. Verify journal rows, statuses, request IDs and fingerprints.
3. In a disposable Windows VM with a packaged build, exercise two sequential Agent boots/reboots and two SQLite-generated RESTART/recycle cycles. Pin hash and count before/after each transition; verify UNKNOWN and terminal tombstones were not deleted or replayed.
4. Inject live worker/legacy PID and PID reuse cases. Confirm Task Scheduler startup error is distinct from a Broker task being Running or HTTP 401. If owner birth/metadata readback is denied, preserve diagnostic availability but block mutations.
5. Do not run checkpoint, VACUUM, purge, automatic migration/restore or forceful process termination on the actual Work-PC as part of this source test. A separate owner-confirmed, coordinated physical acceptance is required.
6. Report every phase as PASS/FAIL/NOT_RUN with logs redacted and exact source SHA. Physical acceptance remains NOT_RUN until AI-09 supplies reproducible evidence.

## Rollback
This branch only adds tests and this documentation. Rollback is to close the draft PR or revert its commit(s). No Windows installation or journal state requires rollback.
