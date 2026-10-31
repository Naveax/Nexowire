# AI-01 | WAL v1.0.8 source hardening

- Base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (`main`, verified 2026-10-31).
- Branch: `ai/01-wal-v108`.
- Scope: `src/agent/operation-journal-wal.ts`, a new `test/ai01-wal-*.test.ts`, and own handoff folder only.
- No live database, Agent, Windows device, deployment, CORE or credentials were used.
- Isolation note: GitHub API branch operations were used; the sandbox's DNS blocked a full local clone, so a local `git status` / `git diff` / full `npm ci` is **not** asserted.

## Evidence ledger

- Main source, #954, #957, #978 and issue #974 inspected through the GitHub connector.
- New tests use only SQLite-created disposable snapshot files; controlled stat hook injects late WAL/SHM in-place rewrites; pathname swap negative runs on POSIX only.
- The user's real journal is **not** accessed; no physical Agent acceptance is claimed.
- Local full repository tests/typecheck/build: **NOT RUN** because the container cannot resolve github.com to clone the repository. No PASS is inferred.
- Hosted CI workflow/run ID/exact HEAD: **PENDING**, must be filled from observed checks. SKIPs must not be called PASS.
