---
manifest_version: 2
name: backup-integrity-audit
description: Verify a known file-level backup set without restoring it by checking expected membership, file metadata, and bounded SHA-256 evidence against an explicit baseline or backup manifest.
version: 0.1
requires: files.list, files.stat, files.hash
prefers: files.read_many
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: backup, integrity, hash, recovery, audit
concurrency: parallel-safe
replay: safe
---

# Backup Integrity Audit

Use this skill when a backup already exists and the question is whether it is still present, complete, and byte-consistent enough to trust for a later restore. This workflow never restores or overwrites data.

## Workflow

1. Identify one exact backup root and the expected backup set. Prefer an explicit manifest, previously recorded hashes, or a user-supplied file list. A directory that merely looks like a backup is not a baseline.
2. List the bounded backup location and compare membership with the expected set.
3. Stat only the expected files and record missing, unexpected-type, size, and modification-time evidence.
4. Hash integrity-critical files with `files_hash`. Independent hashes may run in parallel.
5. When the backup includes a small manifest or checksum file, read only that metadata with `files_read_many`; do not pull ordinary backup payload contents into model context.
6. Compare current SHA-256 values with the explicit baseline. Report `verified`, `changed`, `missing`, `unexpected`, and `unverified` separately.
7. If hashing is intentionally bounded and a large file cannot be verified, report it as unverified rather than silently treating existence or size as integrity proof.
8. Produce a compact restore-readiness summary containing exact paths, baseline/current metadata, and any gaps that must be resolved before restoration.

## Replay and concurrency

The workflow is read-only and safe to replay. File stats and hashes for independent backup entries may run concurrently when they stay within normal I/O limits.

A repeated audit is new evidence. Do not reuse an older successful hash result after the backup may have changed.

## Rules

- Do not restore, copy, delete, rename, or repair backup files in this workflow.
- File existence is not integrity.
- Matching size and mtime are not substitutes for a required cryptographic hash.
- Never invent the expected backup inventory. If no baseline or manifest exists, report that completeness cannot be proven.
- Distinguish a corrupt/changed file from a file that could not be verified within bounded I/O.
- Keep payload contents out of the response unless the next decision genuinely requires a small metadata file.
