# AI-01 | WAL v1.0.8 source hardening

- Base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (`main`, verified 2026-10-31).
- Branch: `ai/01-wal-v108`.
- Scope: `src/agent/operation-journal-wal.ts`, a new `test/ai01-wal-*.test.ts`, and own handoff folder only.
- No live database, Agent, Windows device, deployment, CORE or credentials were used.
- Isolation note: GitHub API branch operations were used; the sandbox's DNS blocked a full local clone, so a local `git status` / `git diff` / full `npm ci` is **not** asserted.

## verifyAgentJournalWal contract

- Accept SQLite-authentic committed current WAL prefix plus prior-generation physical allocation tail only with corroborating consistent WAL-index headers.
- Reject malformed checksum, salt, geometry, conflicting index, torn frames and ambiguous evidence without mutation.
- On a stable file namespace, reject in-place WAL header/SHM index changes detected after the initial parse, and reject replacement of validated WAL/SHM path identities.
- This is a best-effort pre-open preflight, **not** an atomic snapshot or anti-rollback authority. An attacker racing after the final check and before SQLite opens the journal remains an integration risk.

- A nonempty current-generation frame sequence must terminate in a commit-marked frame. Reject a checksum-valid but uncommitted current-generation suffix because SQLite can ignore it and lose an operation reservation; prior-generation allocated suffix after a complete commit remains accepted.

- During WAL/SHM `lstat → open → handle.stat`, device/inode **and initial size/mtime/ctime metadata** must agree. An in-place pre-open truncate/metadata drift fails closed even if the opened inode remains the same. This still does **not** provide atomic preflight-to-SQLite-open continuity.

- A WAL that is **absent at the first lstat** remains a legitimate no-WAL state, but a WAL or required recycled SHM **observed present and then missing before open** must fail closed with `AgentJournalWalError` / `AGENT_JOURNAL_WAL_CORRUPT`. This preserves the journal startup diagnostic contract while retaining the original absence semantics.

- **Orphaned sidecar fail-closed:** if the WAL is absent at its first `lstat` but `dbFile+'-shm'` still exists, reject as `AGENT_JOURNAL_WAL_CORRUPT`. WAL loss can leave a valid-looking older base without WAL-only `UNKNOWN` reservation history; do not silently treat a dangling index as a clean initialization. Both sidecars absent stays a legitimate new/clean journal state. This is not an external anti-rollback proof and does not close the final verify-to-SQLite-open TOCTOU gap.
