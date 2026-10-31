# AI-01 | WAL v1.0.8 source hardening

- Base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (`main`, verified 2026-10-31).
- Branch: `ai/01-wal-v108`.
- Scope: `src/agent/operation-journal-wal.ts`, a new `test/ai01-wal-*.test.ts`, and own handoff folder only.
- No live database, Agent, Windows device, deployment, CORE or credentials were used.
- Isolation note: GitHub API branch operations were used; the sandbox's DNS blocked a full local clone, so a local `git status` / `git diff` / full `npm ci` is **not** asserted.

## Delivery gate

Status: **NO_GO pending exact-head hosted CI and coordinator integration**.

New coverage: stable hot/recycled WAL, late in-place WAL header mutation, late SHM index mutation, and POSIX WAL-path swap. Existing recycled-WAL tests/negatives remain unchanged.

No physical Windows/restart/24-hour soak on an owned machine was performed. Core/production authorization is outside AI-01 and remains NO-GO.
