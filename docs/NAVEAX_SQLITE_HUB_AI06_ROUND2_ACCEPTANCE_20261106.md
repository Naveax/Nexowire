# NEXOWIRE AI-06 ROUND 2 — NAVEAX independent Windows SQLite Hub acceptance and handoff

**Assessment:** 2026-11-06. **Windows only.** Physical deployment, legacy journal migration on NAVEAX, Task Scheduler mutations, Hub start/stop, Agent/Broker/Orchestrator changes, credential enrollment, and Work-PC Hub changes are **NOT AUTHORIZED / NOT PERFORMED**.

## Verified source and CI boundary

- SQLite PR **#1086** source at Round 2 test checkpoint `28e563fd6f8f64baa1e7d707f3e13e4843782c7a`. Previous exact SHA `88fe37ff67fae60550f79d20e51ebb6cabbf5011` passed CI [42108317407](https://github.com/Naveax/Nexowire/actions/runs/42108317407), all seven jobs. The newer commits require their **own** exact-head CI acceptance.
- Integration PR **#1089** was inspected at `37fc9163e2b7ccd93600ee23b63f19d4e44ddb77`. Its CI [42109204286](https://github.com/Naveax/Nexowire/actions/runs/42109204286), Relay [42109204241](https://github.com/Naveax/Nexowire/actions/runs/42109204241), Release Readiness [42109204414](https://github.com/Naveax/Nexowire/actions/runs/42109204414) all succeeded, **but the integration retains old JSON store blob `27c6551dbbe051d553fa86e999136ea2af875b31`** with artificial 2,000/5,000 limits. Green CI on this old integration does not validate SQLite.
- Source `src/operations/idempotency-store.ts` on #1086 includes WAL, per-connection `PRAGMA synchronous=FULL`, startup `PRAGMA quick_check`, SQL transaction migration and immutable terminal/UNKNOWN reservations, plus **per-mutation `hub_writer` incarnation revalidation** to block a previously initialized writer after ledger ownership changes.
- New Windows-only **read-only** `scripts/ai06-hub-sqlite-cutover-preflight.ps1` refuses JSON-only reader targets, remote/reparse state directory, foreign write-capable ACL entries, incorrect owner SID, unexpected Hub task (optional gate), unproven legacy SHA, missing/corrupt SQLite header (first-migration exception guarded by exact JSON hash). This is a **preflight**, not a substitute for full `quick_check`, binary trust, Windows task identity verification or an updater-integrated mandatory rollback guard. The script is **NOT** wired to the existing Windows update path yet.

## Windows isolated test evidence

- Pinned #1086 checkout `1b85b2c25d1822e10269bd49188bd667fd225408`: TypeScript typecheck **PASS**, 19/19 targeted SQLite tests **PASS**.
- Pinned #1086 checkout `28e563fd6f8f64baa1e7d707f3e13e4843782c7a`: TypeScript typecheck **PASS**, 20/20 targeted SQLite/PowerShell preflight tests **PASS**, Node.js v24.15.0 on real Windows through a disposable staging checkout. Fixture and checkout cleaned. **No production journal or scheduled task changed**.
- The aborted transaction test causes the child process to exit with an uncommitted WAL transaction; subsequent SQLite initialization observes no partial DDL, and 80 synthetic legacy records migrate intact.
- Synthetic migration UNIQUE failure leaves 0 partial tombstones, no `schema_version` and no `hub_writer` marker; original JSON hash remains unchanged.
- Synthetic disk-full injection uses an aborting SQLite INSERT trigger; **does not** simulate power loss or physically exhaust storage.
- Live cross-process test: second process attempting the same journal receives `IDEMPOTENCY_HUB_WRITER_ACTIVE`; different local stateDir is accepted; synthetic recycled PID/incarnation is denied; loss of ownership after initialization blocks future begin/complete.
- JSON-only rollback negative demonstrates that a post-cutover SQLite key is absent from legacy JSON; an older JSON reader cannot be a safe fallback. **Existing updater has not yet been proven to invoke the new read-only preflight**.
- Temporary #1089 + #1086 **source-overlay** (before adding the PowerShell preflight and its test): pinned integration SHA `37fc9163e2b7ccd93600ee23b63f19d4e44ddb77`, source SHA `1b85b2c25d1822e10269bd49188bd667fd225408`: typecheck **PASS**, 24/24 integration-relevant tests **PASS**; no commit pushed to #1089 and no production device changes. AI-05 must bring forward the newer exact final blobs and rerun acceptance.

## Live device read-only evidence

| Property | NAVEAX | Work-PC |
|---|---|---|
| Local Hub Scheduled Task | Absent | Running |
| Hub 127.0.0.1:43110 listener | Absent | Present |
| Legacy JSON | 80 keys (79 succeeded, 1 failed) | Preserved legacy JSON |
| SQLite | Not installed | 2,001 records, quick_check=ok |
| Native Agent and Broker | Running | Running |
| Owner | `NAVEAX\\navea` user-SID ending 1001 | `umut` user-scoped Hub task |
| Task safety | `Nexowire Stack` Disabled | `IgnoreNew` and Limited Hub task |

NAVEAX legacy JSON SHA256 `8BE67D0F5FE4E13AA00646B73F355C0407DD17E1EA4CD6339DFF6F6D6609761A` was **unchanged** on readback. NAVEAX profile state root has Administrators, SYSTEM and intended user FullControl; inherited `CodexSandboxUsers` only ReadAndExecute. That read access still needs a separate **confidentiality** review before using the directory for credentials. Neither NAVEAX nor Work-PC shares the other's local filesystem journal. **At the latest NAVEAX inventory 3194 was not listening**; no attempt was made to start or modify Orchestrator or alter its reserved port.

## Windows configuration contract for NAVEAX (future, approval required)

- Machine binding: **NAVEAX only**; `NEXOWIRE_HTTP_HOST=127.0.0.1`, `NEXOWIRE_HTTP_PORT=43110`, `NEXOWIRE_STATE_DIR=C:\\Users\\navea\\.nexowire\\hub` (or an approved dedicated protected state root with a verified complete metadata migration); never UNC/shared/symlink.
- Work-PC independently retains `127.0.0.1:43110` on a **different** host and `C:\\Users\\umut\\.nexowire\\hub`. Port 3194 is exclusively reserved for NAVEAX Orchestrator; 43112 for Broker.
- Candidate task: `\\Nexowire Hub`, **no `-Force` overwrite**, no existing task name collision, TaskPath exact `\\`, principal SID must equal approved local owner SID, `LogonType=Interactive`, `RunLevel=Limited`, `MultipleInstances=IgnoreNew`, trigger `AtLogOn`, action pinned to integrity-verified versioned launcher under safe ACLs. Never copy Work-PC bearer/DPAPI credentials. Keep existing `Nexowire Stack` Disabled.
- `AtLogOn` **does not provide pre-login availability**. Pre-logon 24/7 requires an **independently approved** LocalMachine-DPAPI + secure SYSTEM/AtStartup design and virtualized Windows acceptance; do not silently promote the user-scoped task to SYSTEM.
- Before installation: independently reverify expected NAVEAX JSON SHA/count, exclusivity of Hub writer/port, absence of existing task, no active JSON writer, effective DACL, backed-up Task XML and source SHA, SQLite-compatible rollback binary, and authorized owner/device enrollment. Do not use Windows lifecycle's generic `Register-ScheduledTask -Force` on this machine without task identity/lease fencing and explicit approval.
- Migration: stop any legacy writer *only under approval*, take an access-controlled, consistent backup of all state/journals, test on an **isolated** directory, compare 80 UUID/key/status/fingerprint records, retain original JSON byte-for-byte, then perform a controlled SQLite cutover once and verify `quick_check=ok` and WAL/FULL. A read-only header check is **not** sufficient.
- A JSON-only rollback is **forbidden after any SQLite reservation**. Require the read-only downgrade guard as a **mandatory** step in the actual updater/rollback path; restore only a verified SQLite-capable binary **against the intact current ledger**. Quiesce writes; preserve `.sqlite`, `-wal`, `-shm` and original JSON together. No tombstone deletion, no blind replay, no old-snapshot overwrite after new effects.
- This project currently supports independent local anti-replay per machine, **not** distributed exactly-once when both machines can affect the same target. Owner/device epoch and authoritative effect handoff must be independently verified by AI-03/05 before any cross-Hub remote mutation is permitted.

## AI-05 exact blob integration handoff

All paths below must be carried from the **final #1086 HEAD**, not cherry-picked opportunistically from the older SHA. At checkpoint `1b85b2c25d1822e10269bd49188bd667fd225408`:

| Path | Source Git blob |
|---|---|
| `src/operations/idempotency-store.ts` | `9acc02ba8c63595f0cdfdc6a3b85b11fbdb4329d` |
| `test/idempotency-store.test.ts` | `4c1a151a1ada9b8d8e0ac3bdbca760c141ffc0c0` |
| `test/idempotency-journal-concurrency.test.ts` | `6ba436bffbc973340d9dbd1a62d980a66322aa45` |
| `test/idempotency/hub-capacity-recovery.test.ts` | `3f7d77c254834fd4900a94964ac780e0244df201` |
| `test/idempotency/naveax-local-hub-80-rehearsal.test.ts` | `11109ee9214d2df391c468b073fb94289cab6fca` |
| `test/idempotency/sqlite-hub-writer-and-failure.test.ts` | `b48c0bda9a6772928bf54bf98ef40c0d754e2b4a` |
| `test/mcp-agent-outcome-reconciliation.test.ts` | `bf48d3ee8a7489d96312b5ce8610746bf5ff85f0` |
| `test/mcp-idempotency-continuity.test.ts` | `6078149a272aa36d83d9e5f6ec6a2044fe6032b7` |
| `docs/NAVEAX_LOCAL_SQLITE_HUB_AI06_20261105.md` | `801d176f5d9f9e9a009a140e3f760108292d0716` |
| `docs/HUB_IDEMPOTENCY_CAPACITY_RECOVERY_20261105.md` | `6e102ff673ff3f28903f131269930cbc91455922` |

Also import from the **newer final #1086 HEAD**: `scripts/ai06-hub-sqlite-cutover-preflight.ps1`, `test/idempotency/sqlite-windows-cutover-preflight.test.ts`, and this Round 2 report. Both integration and source PR exact-head CI must pass again. Do not overwrite newer #1089 security code on overlapping files.

## AI-07 / AI-08 release handoff

- **AI-07:** integrate mandatory preflight into real Windows updater/rollback logic; prevent Task Scheduler `-Force` clobber; validate owner SID, action launcher provenance, ACL effective write/read permissions, historical state, 3194/43112 port isolation, crash/forced exit behavior, and SQLite-compatible rollback. Real reboot tests only in disposable Windows VM until approval.
- **AI-08:** after authorized NAVEAX physical cutover, independently test both local Hub identities, state roots and writer claims; verify stale epoch/lease, UNKNOWN, lost ACK, duplicate UUID, reconnect, owner/device isolation and no cross-Hub replay. Snapshot Work-PC Hub before and after: must remain unchanged by NAVEAX setup.
- **Release:** remain **DRAFT / NO-GO** for physical two-Hub installation, cross-device exactly-once routing and rollback until completed gates have exact source and device evidence.
