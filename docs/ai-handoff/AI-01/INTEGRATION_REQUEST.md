# AI-01 | Coordinator-owned journal API integration request

- **Repo / base:** `Naveax/Nexowire`, `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- **AI-01 Draft / source:** https://github.com/Naveax/Nexowire/pull/986 / `236d256224724e1df1b4da1431b60c4a27b896ea`.
- **AI-01 ownership:** `src/agent/operation-journal-wal.ts`, new `test/ai01-wal-*.test.ts`, own handoff folder only. Never edit shared `src/agent/operation-journal.ts`.
- **No live journal/Agent/Hub/Broker, credentials, Windows device, UAC/DPAPI, CORE or deploy.**

## Exact gap

`src/agent/operation-journal.ts:122-149` first `lstat`s DB, asynchronously calls `verifyAgentJournalWal(db)`, then `lstat`s SHM, then constructs `new DatabaseSync(db)`. These separate pathname operations do **not** prove that the validated WAL/SHM is the same namespace SQLite recovers or opens.

The present AI-01 validator rejects corrupt current WAL, valid RESTART reuse false positives, pre-open metadata and disappearing-file races, and missing WAL with orphaned SHM. None is a substitute for an atomically held OS namespace or independently rollback-resistant reservation authority. **If both sidecars are removed before discovery, local absence looks like a clean start and cannot prove that a previous WAL-only `UNKNOWN` tombstone existed.**

## Minimal coordinator acceptance contract

1. Under a real OS-enforced **single-owner native lease / exclusive journal namespace**, validate a stable DB/WAL/SHM identity and WAL generation before SQLite recovery. Hold the same trustworthy namespace protection across SQLite open and until journal admission is established; no window in which another process can replace/delete sidecars after validation. A file's ordinary `stat()` or synthetic receipt is not sufficient.
2. If continuity/ownership/readback is uncertain, **deny mutations**, leave the replay record terminal `UNKNOWN`, and emit redacted diagnostics. Do not auto delete WAL, checkpoint, reset DB/tokens or mark fabricated user consent.
3. For deleted-sidecar rollback (both WAL and SHM absent), use an **independently trusted rollback-resistant reservation witness** or equivalent architecture if replay-safe mutation admission depends on WAL-only state. The local SQLite base alone is insufficient evidence.
4. Independent QA negative barriers: WAL replacement immediately after preflight; SHM replacement or truncation; a competing Agent owner; both-sidecar deletion after a WAL-only `UNKNOWN` reservation; valid SQLite RESTART and older allocated tail as a **positive**. Require deny-before-executor for ambiguous cases and non-replay after lost ACK.
5. AI-08 must test a single reviewed integrated exact HEAD; distinct owner-PR green CI cannot be combined into fake integration or physical acceptance.

This is a **request**, not an implementation in the coordinator-owned source. Draft/CORE production **NO_GO**; merge and physical acceptance separate.
