---
name: git-safe-workflow
description: Inspect Git state, isolate changes, and make reversible commits without trampling unrelated work.
version: 0.1
requires: workspace.snapshot, search.text, shell.exec
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: git, repo, commit, safety
---

# Git Safe Workflow

Use this skill whenever work modifies a Git repository.

## Workflow

1. Read the fresh workspace snapshot and current branch before editing.
2. Inspect `git status --short --branch` and the relevant diff.
3. Never discard, reset, stash, or overwrite unrelated user changes just to make the tree look clean.
4. Use targeted search/read before editing; avoid broad rewrites when an exact patch is enough.
5. Run focused verification for changed areas.
6. Re-read the diff after generated formatters/build steps because humans invented tools that edit files while claiming merely to inspect them.
7. Stage only intended paths.
8. Commit one coherent slice with a factual message.
9. Verify the resulting HEAD and working tree.
10. Push only the intended branch; use force-with-lease only after an intentional rebase and after verifying the remote branch head.

## Parallel work

Prefer separate branches/worktrees for independent slices. If two slices touch hot files, serialize their merge/rebase step rather than resolving the same conflict twice.

## Safety

- Never use `git reset --hard`, destructive clean commands, or force-push as routine cleanup.
- Never claim a push succeeded without observing its exit state or remote head.
- Repository state and tests override stale handoff notes.
