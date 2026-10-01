---
name: durable-runbook
description: Compose persistent task graphs and read-only postcondition groups into a higher-level resumable workflow that survives native-agent restart without persisting command/output payloads.
version: 0.1
requires: runbook.run, runbook.list, runbook.get, runbook.prune, task.graph.run, verify.assertions
---

# Durable Runbook

Use a durable runbook when a goal spans multiple execution phases and later phases should depend on verified earlier state.

A runbook step is either:

- `task_graph`: a persistent bounded shell-job DAG.
- `assertions`: a read-only postcondition group.

The runbook layer persists only workflow metadata, specification hashes, attempts, status, dependency state, and derived task-graph references. It does not persist command text, stdout/stderr, assertion needles, or artifact contents.

## Typical flow

1. Choose a stable `runbook_id` for the goal.
2. Put independent build/test/deploy preparation work into one or more `task_graph` steps.
3. Put state verification into `assertions` steps.
4. Connect steps with `depends_on`.
5. Use a small `max_parallel` value unless steps are known to be independent.
6. Inspect `runbook_get` after interruption or before retry.
7. Resume with the exact same specification.

## Resume rules

- Successful steps are reused.
- A read-only assertion step that was in flight during restart is safe to retry automatically.
- A task-graph step that was in flight during restart becomes `unknown` and is not replayed unless `retry_unknown: true`.
- Failed steps require `retry_failed: true`.
- Dependents blocked by a step being retried are reopened and re-evaluated.
- A changed runbook specification is rejected instead of being silently mixed with persisted state.

## Task-graph IDs

Runbook task-graph steps receive deterministic internal graph IDs derived from the runbook ID and step ID. Do not manually supply `graph_id`, `resume`, `retry_failed`, or `retry_unknown` inside the nested task graph. The runbook owns those fields.

## Output discipline

Runbook responses summarize nested task-graph results instead of recursively embedding command output. Inspect the referenced task graph or its artifact metadata only when needed.

## Safety

- Runbooks do not make unsafe mutation replay safe.
- Unknown mutation/task state stays unknown until explicitly retried or verified.
- Prefer assertion steps after important mutations.
- Use task artifacts and artifact verification when a file output is a durable handoff between phases.
- Keep secrets out of command lines and runbook specifications.
