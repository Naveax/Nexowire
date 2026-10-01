---
manifest_version: 2
name: workspace-regression-triage
description: Reproduce and narrow a software regression from repository state, targeted checks, bounded search, and relevant file reads before attempting a fix.
version: 0.1
requires: workspace.detect, workspace.snapshot, workspace.checks, search.text, files.read_many
prefers: task.graph.run, git.status
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: workspace, regression, tests, debugging, triage
concurrency: serial
replay: verify
---

# Workspace Regression Triage

Use this skill when a project that previously worked now fails build, test, lint, typecheck, or runtime validation.

## Workflow

1. Detect the workspace and capture the current snapshot before running checks.
2. Run the smallest relevant `workspace_checks` target that reproduces the failure.
3. Record the failing command class, exit code, bounded stderr/stdout, and the files or symbols named by diagnostics.
4. Search only for the implicated symbol, configuration key, error string, or test name.
5. Read the smallest relevant file set with `files_read_many`.
6. Compare diagnostics with current workspace state. Do not assume every dirty file caused the regression.
7. If multiple independent checks are needed, use a task graph only when their outputs do not write the same build/cache state.
8. Before any fix, state the reproduced failure and the narrowest evidence-backed cause hypothesis.
9. After a fix, rerun the smallest reproducer first, then the broader check set needed to prove no regression remains.

## Replay and concurrency

This is `mixed` because build/test/check commands may create caches, generated files, or other workspace side effects even when their intent is diagnostic. Do not classify the workflow as replay-safe.

If an interrupted check has ambiguous side effects, inspect workspace state before rerunning it. Keep the workflow serial unless the specific project proves independent checks are safe to run concurrently.

## Rules

- Reproduce before editing.
- Prefer diagnostic paths and symbols over broad repository reads.
- A passing unrelated test suite does not disprove the reported regression.
- Do not clean caches or generated files until evidence shows they are involved; cleanup destroys useful forensic state.
