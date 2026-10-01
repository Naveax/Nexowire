---
name: repo-resume
description: Resume an existing software workspace from its real current state without redoing completed work.
version: 0.1
requires: workspace.snapshot, search.text, files.read_many, shell.exec
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: repo, resume, workspace, recovery
---

# Repo Resume

Use this skill when the user asks to continue, resume, or pick up a software project.

## Workflow

1. Load the saved Nexowire workspace checkpoint when one exists.
2. Get a fresh workspace snapshot before changing anything.
3. Inspect the current branch, dirty files, recent commit, running processes, and the smallest relevant file set.
4. Reconcile the checkpoint with reality. The filesystem and Git state win when they disagree with old notes.
5. Continue only unfinished work.
6. Save a new checkpoint after meaningful progress.

## Efficiency rules

- Do not recursively read an entire repository by default.
- Prefer Git status/diff and targeted search.
- Reuse already-running build or development processes when safe.
- Keep the checkpoint factual: completed work, remaining work, blockers, tests, and exact next action.
