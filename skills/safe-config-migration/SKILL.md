---
name: safe-config-migration
description: Migrate a configuration file or directory with preflight validation, exact backups, conflict-safe edits, verification, and rollback evidence.
version: 1.0
requires: files.read, files.stat, files.hash, files.copy, files.patch
platforms: any
mutation: mutation
privilege: user
trust: trusted
tags: config, migration, rollback, files
---

# Safe Config Migration

Use this workflow for application configuration upgrades where preserving the old known-good state matters.

## Workflow

1. Identify the exact source and destination files and the software version expecting the new format.
2. Read/stat/hash the original before mutation.
3. Create a timestamped or operation-ID-scoped backup with `files.copy`.
4. Parse or inspect only the relevant configuration sections.
5. Apply the smallest exact patch. Prefer revision-aware/conflict-safe patching over blind rewrite.
6. Validate syntax with the application's own read-only validator when available.
7. Restart or reload only if the application's documented behavior requires it.
8. Verify both the intended setting and application health.
9. Retain the original hash and backup path in the result so rollback remains concrete.

## Rollback

If validation or post-change health fails, restore only from the backup created for this operation, then verify the restored hash and application state.

## Safety

- Never overwrite the sole copy before creating a verified backup.
- Do not merge unknown secrets into logs or responses.
- Treat concurrent modification as a conflict, not permission to overwrite.
- Do not invent configuration keys absent from the target software/version.
