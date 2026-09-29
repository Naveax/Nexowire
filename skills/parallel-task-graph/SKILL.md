---
name: parallel-task-graph
description: Run independent shell jobs concurrently while enforcing explicit dependencies, bounded concurrency, output limits, and failure blocking.
version: 0.1
requires: task.graph.run
---

# Parallel Task Graph

Use this skill when several terminal jobs can run independently or form a small dependency graph.

## Workflow

1. Split the work into jobs with stable IDs.
2. Express only real dependencies with `depends_on`.
3. Keep unrelated checks or builds independent so Nexowire can run them concurrently.
4. Use `max_parallel` conservatively. Two to four is a sane default for CPU-heavy builds; use more only for mostly I/O-bound work.
5. Give every graph a bounded `total_timeout_ms`.
6. Inspect failed and blocked jobs separately. A failed dependency blocks only its dependents unless `stop_on_failure` is enabled.

## Safety and correctness

- Do not model destructive operations as parallel merely because they can technically overlap.
- Jobs may mutate the machine. Provider failover therefore treats the whole graph as a mutation and will not blindly replay it after ambiguous transport failure.
- Prefer structured workspace checks for ordinary build/test/lint/typecheck validation. Use a task graph when you need dependencies, heterogeneous commands, or deliberate concurrency.
- A blocked job did not execute. Do not report it as a failed command.
- Keep job output bounded. Large logs belong in files, then search or read the relevant ranges.
