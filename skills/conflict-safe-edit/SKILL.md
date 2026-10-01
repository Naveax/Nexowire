---
name: conflict-safe-edit
description: Edit source/config files with SHA-256 stale-read protection so AI changes do not silently overwrite concurrent edits.
version: 0.1
requires: files.read, files.read_many, files.hash, files.patch
platforms: any
mutation: mutation
privilege: user
trust: reviewed
tags: files, editing, concurrency, safety
---

# Conflict-Safe Edit

Use this skill for source code, configuration, and other text files that may change while the AI is working.

## Workflow

1. Read the target file with `include_sha256: true`, or batch-read related files with hashes.
2. Plan the smallest exact text replacements.
3. Call `file_patch` with the SHA-256 returned by the read as `expected_sha256`.
4. Treat `FILE_CONFLICT` as a stale-read signal, not as a patch failure to brute-force.
5. Re-read the current file, reconcile the newer content, then construct a fresh patch.
6. Use the returned final SHA-256 as the new revision identity for follow-up edits.

## Rules

- Never remove `expected_sha256` merely to force through a conflict.
- Prefer exact replacements with `expected_count` over broad text substitutions.
- Batch-read related files with hashes when an edit spans several known files.
- Re-run the narrowest relevant validation after a patch, then broader checks before finishing.
