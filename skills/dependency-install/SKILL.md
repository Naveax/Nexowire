---
name: dependency-install
description: Add, remove, or repair project dependencies using the repository's native package manager and verification loop.
version: 0.1
requires: workspace.detect, workspace.snapshot, files.read_many, shell.exec
platforms: any
mutation: mutation
privilege: user
trust: reviewed
tags: dependencies, packages, install, build
---

# Dependency Install

Use this skill for package/dependency changes in an existing workspace.

## Workflow

1. Detect the project and package manager from lockfiles/configuration.
2. Inspect the current dependency declaration and lockfile before mutation.
3. Use the native package manager rather than manually editing resolved lock data.
4. Add the narrowest dependency/version range that satisfies the task.
5. Capture install exit status and relevant warnings.
6. Run focused typecheck/build/tests that exercise the dependency.
7. Inspect the resulting manifest and lockfile diff for unrelated churn.
8. Record the exact package-manager command in the workspace checkpoint.

## Safety

- Do not globally install a package when a project-local dependency works.
- Do not remove lockfiles to make resolution errors disappear.
- Treat lifecycle/postinstall scripts as code execution.
- Never expose registry credentials or auth tokens in command lines or logs.
