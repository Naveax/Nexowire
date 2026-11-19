# AI-04 SQLite / Hub Recovery | 2026-11-08

Owner: AI-04. Candidate base: PR #1096 at `43e8125e7a4ced654a769b661dc10938c02bc7a4`.
This is source-level recovery work plus a **Work-PC-only** observed Hub task restart.
The source fix in this branch was **not deployed** to the running Hub.

## Physical Work-PC observations

- Before touching the Hub task, a consistent online SQLite backup of the live
  Hub idempotency ledger contained 2,477 records; live and backup record-content
  SHA-256 digests matched and `PRAGMA quick_check=ok`, `journal_mode=wal`.
- A separate live Agent operation-journal SQLite backup was made with the
  `node:sqlite` backup API. Both source and saved journal returned
  `quick_check=ok`; all three user-table definitions were retained.
- Immediately before the Hub task restart, a new read-only SQLite backup
  captured **2,495** idempotency records, with zero `in_progress`.
- `Nexowire Hub` scheduled task was stopped and restarted on Work-PC. Old
  TCP/Hub writer PID **6928** changed to **1792**. `/health` returned HTTP 200.
- Post-restart: **2,497** rows; among all 2,495 pre-restart rows,
  **0 missing**, **0 immutable fields changed**, **0 terminal statuses changed**.
  Hub database `quick_check=ok`, WAL mode and writer PID 1792 verified.
- Local audit: `%LOCALAPPDATA%\Nexowire\maintenance\ai04-hub-restart-result-20261108.txt`.
  Backups remain local, under the original protected user profile, not in Git.
- The Work-PC `Nexowire Automatic Update` scheduled task was **Disabled**.
  Official signed upgrade + rollback **NOT_RUN**. Neither PC was rebooted.

## Regression and source behavior

- Original defect: `IdempotencyStore.initialize()` treated a second store
  instance within the *same* live Hub process as a crash/restart and converted
  active `in_progress` rows into terminal `unknown`.
- Fix: the SQLite transaction recovers abandoned rows **only if the durable
  writer claim belongs to a different process incarnation**. A new actual
  process still tombstones abandoned reservations as `unknown`.
- Tests now model a genuine restart using a separate Node.js process, rather
  than a second instance in the test process.
- A new online-WAL backup test checks that the backup has committed rows and
  that the running Hub writer can continue appending after the snapshot.
- Existing negative cases cover two-process writer collision, conservative
  PID reuse, failed partial migration, UNIQUE constraint rollback, simulated
  disk-full INSERT, legacy JSON drift, and JSON-only downgrade rejection.
- Source-preservation matrix retains the PR #1086 original Git blob and marks
  the evolved candidate explicitly as `EVOLVED`.

## AI-01 SYSTEM Hub migration handoff: acceptance requirements

1. **Backup first**: while the user Hub runs, take a consistent SQLite online
   backup, plus snapshot/manifest for Agent operation journal, and verify
   `quick_check=ok`. Do not copy the bare `.sqlite` file while WAL is active.
   Retain old JSON files and live databases; never replace new live records
   with an older snapshot during rollback.
2. **One writer**: stop the old user Hub, verify its listener and owned writer
   process have actually exited, and only then start the SYSTEM Hub. Do not
   count a Scheduler `Running` state alone as proof.
3. **State handoff**: persist the exact state-directory decision in the
   SYSTEM launcher, apply explicit ProgramData owner/SYSTEM ACLs and
   LocalMachine DPAPI requirements, and validate the new Hub can open the
   *intended* SQLite database. An empty fresh DB must not be mistaken for a
   successful migration.
4. **Data invariants**: compare row counts and immutable fields
   (`key`, `fingerprint`, `operation_id`, capability, target, creation time)
   across all old rows. `in_progress` may conservatively become
   `unknown` after true process replacement; terminal statuses must remain
   stable. Check `quick_check=ok`, WAL, live PID matching writer claim,
   HTTP health, and Agent connectivity.
5. **Rollback**: restore the prior launcher only if that runtime understands
   the *current* SQLite schema and can read all post-cutover reservations.
   Fail closed on a JSON-only reader. Verify task and state directory choices
   before restoring a launcher; never silently roll back a persisted effect.
6. **Disposable VM acceptance**: run actual reboot, unexpected process death,
   upgrade failure, and power interruption with retained SQLite/WAL using an
   isolated Windows guest. Record per-scenario PASS/FAIL/NOT_RUN with logs.

## Current gate status

| Gate | Status |
| --- | --- |
| Live online SQLite backups and quick-check | PASS |
| Live Work-PC **Hub task** restart and ledger continuity | PASS |
| Synthetic writer collision, PID reuse, migration rollback | PASS |
| Actual SYSTEM Hub data transfer | NOT_RUN, AI-01 dependency |
| Official signed automatic update and rollback | NOT_RUN, updater disabled |
| Windows machine reboot / power interruption | NOT_RUN, no disposable VM |

**Release remains NO-GO** until the independent SYSTEM migration, signed
upgrade/rollback, and VM acceptance gates are actually exercised.
