# Agent Operation Journal v2: isolated durability acceptance, 2026-10-18

**Scope and provenance:** The source under test is `Naveax/Nexowire` at merge commit
`8660ac1fa9ec38fd81488a48b34affcb7d71fe65` (merged PR #558), in the
isolated Work PC worktree `test/agent-journal-v2-acceptance-20261018`.
Only disposable temporary SQLite databases, synthetic processes and a disposable
WSL tmpfs mount were changed. **No running Agent/Hub/Broker service or
production journal was upgraded, stopped, erased, restarted or repaired.**
Work PC and Naveax both still report live Agent `1.0.5`; source merge is not
live feature deployment.

## Results and exact meaning

| Gate | Evidence | Result | Limit |
| --- | --- | --- | --- |
| SQLite WAL/FULL and quick_check | `test/agent-operation-durability-acceptance.test.ts`; PRAGMA journal_mode=wal, synchronous=2, quick_check=ok on Win32 Node v24.15 | PASS, isolated | No Windows power-loss or NTFS write-cache flush attestation |
| requestId CAS/replay across close/reopen | Dispatch CAS twice, terminal transitions, identical and altered fingerprints | PASS | No live network duplicate under load |
| Actual crash/restart | Existing killed Node child test, + cold copy DB/WAL/SHM after SIGKILL | PASS; prior dispatched UNKNOWN, terminal preserved; both IDs refuse replay | Same workstation, no separate device |
| WAL/header/main DB corruption | 6 prior hot-WAL integrity checks, earlier main-DB corruption regression | PASS fail closed | No malicious concurrent tampering, backup encryption or ACL protection assessment |
| Clean consistent backup/restore | SQLite `backup()` API after Agent journal closed; restore tombstone still blocks ID | PASS | Recovery of older snapshot intentionally not authorized |
| Cold crash backup/restore | After killed child, copy `.sqlite`, `-wal`, optional `-shm` in quiescent state; restore succeeds | PASS | Do NOT raw-copy hot live DB while writer is active |
| Real NTFS write denial | Apply `icacls <DISPOSABLE_DB> /deny <CURRENT_USER>:(W)`; initialize/mutation refused; remove deny; record survives | PASS | One account/file, not Windows SYSTEM/Admin Bridge/UAC, no directory inherited ACL or alternate path checks |
| SQLite quota failure | Test-only `PRAGMA max_page_count` exhausts writes; no dispatch | PASS, synthetic `SQLITE_FULL` | Not a real NTFS ENOSPC event against the packaged Agent |
| Genuine filesystem ENOSPC | Root-only WSL tmpfs, `size=6m`, Python SQLite WAL/FULL; 55 committed 64-KiB batches then `database or disk is full`; prior UNKNOWN record remained readable | PASS, isolated OS substrate | Linux Python SQLite only, **not** Nexowire Agent implementation; no Windows volume saturation |
| Offline result lookup | Durable Hub `IdempotencyStore` reopened without Agent; original operation UUID yields UNKNOWN, plus existing MCP scope regressions | PASS, simulated offline | No authenticated live hosted Hub + revoked owner scenario |
| Stale/rolled-back backup | Consistent backup predating a completed requestId is restored elsewhere; `begin()` accepts that **historical** request ID as `created:true` | **FAIL / RELEASE BLOCKER** | Known lack of trusted independent anti-rollback watermark; test NEVER executes mutation |

**Run evidence:**
- Isolated new tests: 7/7 PASS, but the stale-restore test deliberately proves a
  **security failure** and therefore PASS on the test runner is NOT release PASS.
- Existing journal/reconciliation/status/WAL/MCP tests: 33/33 PASS.
- Final broader Agent, MCP, provider, authorization, continuity and audit
  regression run: **93/93 PASS**, 0 failed, 0 skipped, 15.0 seconds (Windows
  Work PC); this includes all 7 acceptance tests. This passing runner is **not**
  a release PASS because the stale-restore vulnerability was successfully
  reproduced.
- `npm run typecheck`: PASS.
- Isolated WSL 6 MiB tmpfs ENOSPC: PASS for SQLite/Linux only.
- No new production/runtime modification. This draft acceptance PR is NOT a
  fix for the stale-backup security problem.

## Confirmed release blocker: restoring an older journal

A successful Agent mutation is recorded *after* the snapshot is taken.
Restoring that snapshot loses the durable tombstone; without an independent,
tamper-protected monotonically advancing reservation record, the same
`requestId` can be newly reserved again. The test deliberately performs
`begin()` **only** to prove the failure. No mutation executor is invoked.
Neither WAL checksums nor SQLite `quick_check` detect a valid, old snapshot.

**No unguarded raw restore of this journal is approved.** Backups must preserve
`-wal`/database consistency and must be bound to a separate trusted,
anti-rollback authority (for example, a signed/externally durable append-only
request-ID ledger or authoritative Hub record capable of verifying a complete
restoration high-watermark). The same directory's copy of a manifest or a
plain timestamp is not an independent authority. Before allowing a restored
Agent to issue mutations, compare the journal to that authority; uncertainty,
missing evidence, mismatched scope, unexpected journal gaps or older backups
must fail closed. Restoring a previous Agent *binary* must not roll back or
replace the newer mutation journal.

## Remaining actual physical release steps (all BLOCKED until evidence exists)

1. **Build and identity:** Publish signed Agent/Hub binaries from the merged
   commit plus the separately reviewed anti-rollback fix. Verify binary hashes,
   trusted publisher, Node `node:sqlite` version and database migration against
   the packaged installer in a **disposable test profile**.
2. **Baseline custody:** Record journal DB/WAL/SHM hashes, effective NTFS ACLs
   (including SYSTEM/service user, parent directory and the sidecars), Agent
   process identity, device/account IDs, and separate trusted anti-replay
   watermark. Never copy user secrets or command contents into test evidence.
3. **Safe backup:** Quiesce the *isolated* Agent first or use SQLite's official
   consistent online backup API. Record an authenticated snapshot identifier
   and exact ownership. Verify restore of committed and UNKNOWN entries and
   authoritative watermarks; reject stale rollback unconditionally.
4. **ENOSPC:** Run a fully isolated **Agent process** against a dedicated,
   quota-limited filesystem/VHD or disposable VM and force real OS `ENOSPC`
   during reservation, dispatch-marker, completion, WAL checkpoint and restore;
   ensure no executor entry after failed reservation/marker and UNKNOWN after
   post-dispatch write failures. Do not fill the shared Work PC C: volume.
5. **Real Windows ACLs:** Exercise Agent service identity, temporary deny-write
   on DB/WAL/SHM, controlled ACL restoration, junction/reparse/UNC/symlink
   protection, tampered file replacement and low-disk recovery. Confirm errors
   attribute the denied layer accurately.
6. **Canary rollout, not automatic:** After signed release and explicit
   authorization, upgrade *one* test/canary device while preserving its current
   journal. Prove `agent_operation_status`, successful/failed/UNKNOWN evidence,
   reconnect and same requestId replay denial. Ensure rollback never resets
   tombstones. Then independently verify second-device binding.
7. **Hosted/offline reconciliation:** With owner-authorized production-equivalent
   Hub and network disabled to the canary Agent, query exact UUID and verify
   Hub-only UNKNOWN cannot be represented as terminal Agent proof; repeat with
   revoked owner and wrong device, then reconnect to compare independent Agent
   evidence. No blind retry for `MUTATION_STATE_UNKNOWN`.
8. **Acceptance signoff:** Rerun native/WSL, CI and device two-machine physical
   matrix with audit artifact hashes; publish known-failure/rollback procedure.
   Never equate source CI passing with deployment or physical acceptance.

### Recovery rule

If a mutation may have run but acknowledgement was lost, preserve its original
ID, journal files and logs; inspect **read-only** status and physical
postconditions. Never auto-repeat or silently issue a new ID to hide UNKNOWN.
