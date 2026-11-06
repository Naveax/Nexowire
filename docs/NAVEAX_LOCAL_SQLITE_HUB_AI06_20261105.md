# AI-06: NAVEAX independent Windows SQLite Hub cutover and AI-07 handoff

Scope: **Windows only**. This document is a staging/approval runbook, **not evidence of deployment**. It does not authorize Task Scheduler changes, Hub launch/restart, or device enrollment.

## Exact-source and live read-only evidence (2026-11-05)

- PR #1086 (Draft): branch `hotfix/hub-idempotency-capacity-20261105`, inspected HEAD `af443d0dffec2b793ee3ce83d7e7fd2089de95f0`, base/main `939b4d6beecf996f2750c736c5d4b4beb7b64488`.
- Exact HEAD CI run **42038098864**: seven completed/successful jobs, including Node 22, Node 24 and browser-live. A green CI **does not** prove physical NAVEAX enrollment.
- NAVEAX: Native Agent and Privileged Broker tasks **Running**; legacy `Nexowire Stack` **Disabled**; **no `Nexowire Hub` scheduled task**. Loopback 3194 is the NAVEAX Orchestrator; 43112 is Broker; no listener was observed on 43110/43111.
- Existing NAVEAX legacy journal: `%USERPROFILE%\.nexowire\hub\idempotency-records.json`, schema version 1, **80** keys (**79 succeeded, 1 failed, 0 unknown/in_progress**), 0 duplicate keys, 0 duplicate operation IDs; 34,307 bytes. SHA256: `8BE67D0F5FE4E13AA00646B73F355C0407DD17E1EA4CD6339DFF6F6D6609761A`. Do not check individual keys, payloads, secrets, or credentials into GitHub.
- Work-PC: its own `Nexowire Hub` task **Running** on 127.0.0.1:43110; separate Broker on 43112. Read-only SQLite `quick_check=ok`, 2,001 records (1,959 succeeded, 38 failed, 4 unknown). Its production SQLite binary is **not proven to include every newer PR #1086 commit**. Work-PC is outside the cutover.
- State ACL on NAVEAX `.nexowire\hub`: Administrators, SYSTEM and intended user have full access; inherited `CodexSandboxUsers` permission was also observed. Recheck **effective write** rights, owner, reparse points and ACL inheritance before using this directory as a durable authorization boundary.

## Intended independent NAVEAX configuration

| Setting | Candidate value |
|---|---|
| Hub host | `127.0.0.1` only |
| Hub HTTP port | `43110`, on **NAVEAX**, independent of Work-PC |
| `NEXOWIRE_STATE_DIR` | `%USERPROFILE%\.nexowire\hub` (legacy journal remains there; preserve all non-ledger state) |
| `NEXOWIRE_HTTP_HOST` | `127.0.0.1` |
| `NEXOWIRE_HTTP_PORT` | `43110` |
| Scheduled Task candidate | `Nexowire Hub`, one user-scoped instance, `IgnoreNew`; creation requires separate approval |
| Reserved ports | **3194 Orchestrator**, **43112 Broker**. Never reassign/restart them |
| Work-PC | No task, ledger, route, port, token or service changes |

NAVEAX and Work-PC may both use *43110 on their own loopback interfaces*; they must **never share a SQLite journal path, filesystem, writer token, or implicit cross-PC effect owner**. This is a local-first configuration, **not** distributed exactly-once failover. Authentication and Agent routing/enrollment must be accepted separately; do not copy Work-PC tokens to NAVEAX.

## Ordered gates before the first NAVEAX launch

1. **Recheck exact-source SHA/CI and live machine inventory.** Abort if `Nexowire Stack` or any unknown Hub writer is running, 43110 is already in use, or the planned state directory has changed.
2. Obtain **separate explicit owner approval** for the real device install, any Scheduled Task creation/change, launch/stop, credentials or service restart. This runbook alone is insufficient.
3. Freeze the legacy writer and record JSON SHA256, byte count and validated schema. A JSON writer active during migration defeats the startup-only drift check: do not rely on hashes to solve that race.
4. Make an **access-controlled, byte-preserving backup** of the complete NAVEAX Hub state and any installer/launcher metadata, including existing journals and any `-wal`/`-shm` companions; never export credentials into logs or this repository. Do not delete or overwrite the legacy JSON.
5. On a **disposable Windows staging directory**, make a protected copy of the relevant legacy state. Use the pinned, built SQLite-capable #1086 source; confirm that the state directory is not shared with the real Hub. Run the 80-record migration; verify every key/fingerprint/UUID/capability/target/status and original SHA against the source snapshot. Expect exactly **79 succeeded, 1 failed** and identical 80 UUIDs/keys before synthetic new reservations.
6. Assert SQLite `PRAGMA quick_check='ok'`, WAL journaling, source-side `synchronous=FULL`, transaction failure rollback, unique UUID/key fences, immutable terminal outcomes, failed/UNKNOWN replay blocking and explicit owner/writer claim tests. Existing #1086 regression covers 2,000 -> 2,001 and 5,001 -> 5,003; the added NAVEAX synthetic 80-record regression covers this local fixture profile.
7. Fail closed on changed/invalid legacy JSON, SQLite corruption, permission/lock/disk failures, mismatched fingerprints, writer overlap, or lost ACK. Never evict old tombstones to create capacity. The root of the prior incident was an **artificial** record-count ceiling, not an instruction to disable anti-replay.
8. Stage a versioned application and a **separate Hub-only launcher**. Make the intended Task Scheduler change only after approval and an exact hash/ACL preflight. Do not use `Nexowire Stack` as a substitute, and do not touch the Agent/Broker/Orchestrator tasks.
9. Accept only when the **same Hub PID** owns loopback 43110, the expected versioned runtime is running, SQLite readback matches the historical ledger, both endpoints and source build identity match, owner/device auth is verified and duplicate requests never trigger a second effect.
10. Preserve the old launcher and immutable journal snapshot. Document PID, task definition backup, listener, ledger count/status SHA, tested source SHA and independent owner authorization evidence before declaring GO.

## Safe stop / rollback boundaries

- **Before live task cutover:** leave the current tasks unchanged and retain the original JSON; discard only *synthetic* disposable test fixtures.
- **After the first new SQLite reservation:** **never** switch back to a JSON-only reader. That would lose new UUID/tombstone evidence. Restore a verified **SQLite-compatible** Hub binary/launcher against the **same intact journal**. Do not overwrite the ledger with the pre-cutover copy.
- If the SQLite-compatible prior build cannot be demonstrated, **keep the NAVEAX Hub stopped/fail-closed** and preserve all `.sqlite`, `-wal`, `-shm`, JSON, launcher and Task XML evidence for controlled recovery. No blind replay, UUID reset, journal truncation, or fallback to Work-PC authority.
- Do not stop/restart NAVEAX Orchestrator (3194), Broker (43112), Native Agent or any Work-PC component as part of a Hub-only rollback.

## AI-07 handoff

1. Verify this runbook against the **new exact PR HEAD**, CI jobs and independent Windows disposable migration test log.
2. Obtain owner approval for NAVEAX Task/install/enrollment mutations, then perform only the approved Hub-scoped cutover.
3. Prove disk ACLs, state ownership, snapshot fidelity, quick_check, writer exclusivity and the 80 legacy UUID/status mappings on the new live NAVEAX journal.
4. Verify owner/device authorization, explicit route to the correct Hub, reconnect/UNKNOWN handling and a no-replay round-trip without mutating the Work-PC ledger.
5. Return exact runtime SHA, launch PID, task identity, new ledger counts, acceptance artifacts and a **GO/NO-GO** decision. A CI-green PR alone remains **NO-GO for dual-Hub physical release**.
