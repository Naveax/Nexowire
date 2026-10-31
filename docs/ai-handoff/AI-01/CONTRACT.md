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
