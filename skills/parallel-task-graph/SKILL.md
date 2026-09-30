---
name: parallel-task-graph
description: Run independent shell jobs concurrently with dependencies, bounded concurrency, persistent checkpoints, and explicit restart-safe resume behavior.
version: 0.1
requires: task.graph.run, task.graph.list, task.graph.get, task.graph.prune, task.artifact.list, task.artifact.verify
---

# Parallel Task Graph

Use this skill when several terminal jobs can run independently or form a small dependency graph.

## Workflow

1. Split the work into jobs with stable IDs.
2. Express only real dependencies with `depends_on`.
3. Keep unrelated checks or builds independent so Nexowire can run them concurrently.
4. Use `max_parallel` conservatively. Two to four is a sane default for CPU-heavy builds; use more only for mostly I/O-bound work.
5. Give important long-running graphs a stable `graph_id`. The hub persists only graph/job metadata and a specification hash, never command text or stdout/stderr.
6. Give every graph a bounded `total_timeout_ms`.
7. After reconnect/restart, inspect the graph with `task_graph_get` and resume with the exact same specification plus `resume: true`. Already succeeded jobs are reused instead of rerun.
8. A job that was running when the agent restarted becomes `unknown`. Do not replay it automatically. Use `retry_unknown: true` only after verifying that replay is safe.
9. Use `retry_failed: true` only when rerunning failed/blocked work is intentional.
10. Declare important output files with each job's `artifacts` field. Use `artifact_max_bytes` to bound hashing cost for unusually large outputs.
11. After success, use `task_artifact_list` to inspect persisted artifact metadata and `task_artifact_verify` before relying on an artifact after time, reconnect, restart, or another tool may have modified it.
12. Inspect failed, blocked, and unknown jobs separately. A failed dependency blocks only its dependents unless `stop_on_failure` is enabled.

## Safety and correctness

- Do not model destructive operations as parallel merely because they can technically overlap.
- Jobs may mutate the machine. Provider failover therefore treats the whole graph as a mutation and will not blindly replay it after ambiguous transport failure.
- Prefer structured workspace checks for ordinary build/test/lint/typecheck validation. Use a task graph when you need dependencies, heterogeneous commands, or deliberate concurrency.
- A blocked job did not execute. Do not report it as a failed command.
- An `unknown` job may have executed partially or fully before the connection/restart boundary. Treat its mutation state as ambiguous until verified.
- `graph_id` reuse requires an exact specification hash match. Changing commands, dependencies, timeouts, concurrency, or graph policy creates a mismatch rather than silently resuming the wrong work.
- Keep job output bounded. Large logs belong in files, then search or read the relevant ranges.
- Artifact checkpoints persist only path/size/SHA-256/mtime metadata, never artifact content.
- Artifact re-verification is read-only and bounded. `verified` means the current size and SHA-256 still match the persisted checkpoint; `changed`, `missing`, `unverified`, and `error` must not be treated as verified output.
