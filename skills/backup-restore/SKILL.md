---
name: backup-restore
description: Create and verify bounded file-level backups or restore known backups with hashes, destination checks, and explicit overwrite boundaries.
version: 1.0
requires: files.stat, files.hash, files.copy, files.list
platforms: any
mutation: mutation
privilege: user
trust: trusted
tags: backup, restore, recovery, files
---

# Backup Restore

Use this workflow for file-level backup and recovery inside the native-agent allowlist.

## Backup workflow

1. Resolve the exact source set and destination directory.
2. Stat sources and reject missing/unexpected file types.
3. Record source hashes for files where integrity matters.
4. Copy into a dedicated backup location without overwriting unrelated backups.
5. Stat/hash copied outputs and compare to the source records.
6. Return source, destination, size, hash, and verification state.

## Restore workflow

1. Identify one exact backup set and target location.
2. Verify backup hashes before restore.
3. Inspect the current destination and preserve it first when replacement would destroy unique data.
4. Copy the selected backup files to their exact targets.
5. Verify restored hashes.
6. Run the smallest application-level verification required by the user's goal.

## Safety

- Do not call a directory copy successful without verifying expected outputs.
- Never guess which backup is newest or correct when multiple candidates exist.
- Do not overwrite the current state until rollback material exists when that state may be unique.
- This is file-level recovery, not a claim of database-consistent snapshots unless the application was quiesced appropriately.
