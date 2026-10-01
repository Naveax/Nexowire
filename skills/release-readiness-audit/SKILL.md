---
manifest_version: 2
name: release-readiness-audit
description: Audit whether a software workspace is ready to produce a release candidate by verifying versioning, repository state, build/test gates, packaging metadata, and artifact boundaries before any publication step.
version: 0.1
requires: workspace.detect, workspace.snapshot, shell.exec, files.read_many
prefers: workspace.checks, search.text, files.stat, files.hash
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: release, packaging, versioning, build, test, readiness
concurrency: serial
replay: verify
---

# Release Readiness Audit

Use this skill before creating a release tag, archive, package, or deployment artifact. The goal is to prove that the workspace can produce a bounded, reproducible candidate without accidentally publishing secrets, source-only state, or a version that disagrees with the CLI/runtime.

## Workflow

1. Detect the workspace and capture the current repository snapshot.
2. Record branch, dirty state, version metadata, package/build system, and the intended release artifact type.
3. Refuse to infer release readiness from a passing build alone. Check the project's documented release/readiness script first when one exists.
4. Run the narrowest project-provided release gate. For Nexowire this is `npm run release:check` once available; otherwise run the documented typecheck/test/build gates individually.
5. Inspect packaging metadata and the dry-run artifact/file list before producing a real archive.
6. Verify runtime entrypoints exist in built output and report the expected version.
7. Check that secrets, local state, tests, source-only handoff files, and unrelated development artifacts are excluded from the distributable unless explicitly required.
8. Verify required runtime data such as skills, templates, schemas, or static assets are present in the package.
9. Record package filename, entry count, packed/unpacked size, and hashes when the project exposes them.
10. Do not publish, push a release tag, or upload an external artifact as part of this audit unless a separate explicit release action authorizes that mutation.

## Replay and concurrency

This workflow is `mixed` because build, test, and package-dry-run commands may create caches or generated files even when no release is published. Keep it serial so build/package state cannot race with version or artifact inspection.

On retry, re-read the workspace snapshot first. If a previous interrupted check may have changed generated files or caches, verify current state before rerunning it.

## Rules

- A green unit test suite is necessary evidence, not proof that the distributable is complete.
- A correct package version with a stale CLI-reported version is a release blocker.
- A package that omits required runtime assets is a release blocker even when source-tree execution works.
- A package containing plaintext secrets, local state, or unintended environment files is a release blocker.
- Do not silently clean the workspace before auditing it; dirty/generated state is evidence.
- Treat publication, tag creation, and external upload as separate explicit mutations.
