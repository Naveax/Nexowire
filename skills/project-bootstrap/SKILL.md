---
name: project-bootstrap
description: Initialize or normalize a software project with the smallest viable structure, reproducible commands, and immediate verification.
version: 0.1
requires: workspace.detect, workspace.snapshot, files.read_many, files.write, files.mkdir, shell.exec
platforms: any
mutation: mutation
privilege: user
trust: reviewed
tags: project, bootstrap, setup, repo
---

# Project Bootstrap

Use this skill to create a new project or repair a repository that lacks a coherent build/test entry point.

## Workflow

1. Detect the workspace before creating files. Existing conventions win over generic templates.
2. Identify the language, package/build tool, entry points, test runner, and version constraints.
3. Create only the minimum missing files required for a reproducible build.
4. Pin or constrain tool/runtime versions where the ecosystem supports it.
5. Keep secrets and machine-specific paths out of committed configuration.
6. Add one deterministic typecheck/build/test command before expanding features.
7. Run the smallest end-to-end smoke path.
8. Snapshot the workspace and record exact verification commands.

## Rules

- Do not replace an existing package/build system merely because another one is fashionable this week.
- Prefer checked-in configuration over undocumented local shell state.
- Avoid generating large framework boilerplate unless the task actually needs it.
- New files should be intentionally owned by the project, not copied from random machine state.
