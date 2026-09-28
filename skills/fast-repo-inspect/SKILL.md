---
name: fast-repo-inspect
description: Inspect an unfamiliar repository quickly using compact snapshots, targeted search, and batched reads instead of recursive context dumping.
version: 0.1
requires: workspace.snapshot, search.text, files.read_many
---

# Fast Repo Inspect

Use this skill before broad codebase work when the relevant files are not yet known.

## Workflow

1. Get one workspace snapshot for root, branch, dirty state, last commit, and project markers.
2. Infer likely build/runtime entry points from actual project markers.
3. Search for exact symbols, filenames, errors, routes, or configuration keys related to the task.
4. Read the smallest useful file set with one batched read.
5. Expand only around confirmed references.

## Efficiency rules

- Do not recursively read the repository.
- Do not read generated folders, dependency trees, build output, or vendored code unless the task explicitly requires them.
- Prefer one bounded search_text call over repeated shell grep commands.
- Prefer file_read_many when several known files are needed together.
- Reuse the current snapshot until a mutation makes it stale.
