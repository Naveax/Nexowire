# AI-01 | WAL v1.0.8 source hardening

- Base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (`main`, verified 2026-10-31).
- Branch: `ai/01-wal-v108`.
- Scope: `src/agent/operation-journal-wal.ts`, a new `test/ai01-wal-*.test.ts`, and own handoff folder only.
- No live database, Agent, Windows device, deployment, CORE or credentials were used.
- Isolation note: GitHub API branch operations were used; the sandbox's DNS blocked a full local clone, so a local `git status` / `git diff` / full `npm ci` is **not** asserted.

## Coordinated API handoff required (journal owner, not AI-01)

`src/agent/operation-journal.ts` owns the transition between the separate asynchronous WAL validation and opening the SQLite connection. The validator cannot guarantee atomicity across that transition with repeated `stat`/header readbacks. Please design a native-singleton-protected exclusive journal namespace or equivalent checked-open handshake, with stable DB/WAL/SHM identities and an authenticated, independently rollback-resistant mutation reservation authority where required. If continuity cannot be proven, deny mutation dispatch, retain UNKNOWN tombstones, and emit redacted diagnostics. Do not automatically delete/checkpoint WAL or reset credentials.

This request requires a coordinator-owned source change; AI-01 must not edit `src/agent/operation-journal.ts`.
