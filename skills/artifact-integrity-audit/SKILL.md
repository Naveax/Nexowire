---
manifest_version: 2
name: artifact-integrity-audit
description: Verify persisted task artifact metadata against the current filesystem without trusting stale hashes or reading artifact contents unnecessarily.
version: 0.1
requires: task.artifact.list, task.artifact.verify
prefers: files.stat, files.hash
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: artifacts, integrity, hash, verification, audit
concurrency: parallel-safe
replay: safe
---

# Artifact Integrity Audit

Use this skill when a later stage depends on files produced by an earlier task graph or when cached artifact metadata may have gone stale.

## Workflow

1. Read the persisted artifact metadata with `task_artifact_list`.
2. Identify only artifacts relevant to the current handoff or decision.
3. Re-verify them with `task_artifact_verify`; do not trust persisted SHA-256/mtime metadata as proof of current contents.
4. Treat `changed`, `missing`, `unverified`, and `error` as distinct states.
5. Prefer exact artifact verification over broad directory hashing.
6. Use `files_stat` or `files_hash` only when the artifact record does not cover the file you need.
7. Report the artifact path, expected/current metadata, and verification state without copying file contents unless the next task genuinely needs them.

## Replay and concurrency

The workflow is read-only and bounded. Independent artifact verifications may run in parallel, and the workflow is safe to replay after interruption.

## Rules

- Artifact metadata is evidence, not authority. Re-hash before relying on it.
- Never infer that a missing artifact means the producing task never ran.
- Do not mutate, rebuild, or delete an artifact as part of this audit.
- Keep hash scope bounded; large artifacts may intentionally return an unverified state rather than consume unbounded I/O.
