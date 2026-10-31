# AI-01 | WAL v1.0.8 source hardening

- Base: `a19a228dc6f19fd484cf935e941a00ea625233f8` (`main`, verified 2026-10-31).
- Branch: `ai/01-wal-v108`.
- Scope: `src/agent/operation-journal-wal.ts`, a new `test/ai01-wal-*.test.ts`, and own handoff folder only.
- No live database, Agent, Windows device, deployment, CORE or credentials were used.
- Isolation note: GitHub API branch operations were used; the sandbox's DNS blocked a full local clone, so a local `git status` / `git diff` / full `npm ci` is **not** asserted.

## Status

IN_PROGRESS. Changes staged for Draft PR. Exact HEAD and CI run must be recorded from GitHub when known. #974 is OPEN. #954 was merged; #957 was closed unmerged because the fix was incorporated through merged #978 into v1.0.8.

Next: exact-head hosted CI; independent review, isolated Agent journal restart tests, and coordinate open-to-verify handoff.
