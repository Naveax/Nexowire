---
name: disk-space-recovery
description: Recover disk space by measuring first, identifying bounded high-value cleanup targets, and deleting only verified disposable data.
version: 0.1
requires: machine.health, files.list, files.stat, files.delete, search.text
platforms: any
mutation: mutation
privilege: user
trust: reviewed
tags: disk, cleanup, storage, recovery
---

# Disk Space Recovery

Use this skill when a machine or workspace is low on storage.

## Workflow

1. Read machine health/disk usage before deleting anything.
2. Inspect known workspace/build/cache locations and recent large disposable artifacts.
3. Classify candidates: reproducible build output, package cache, temporary data, logs, user content, unknown.
4. Prefer deleting reproducible build/cache output first.
5. Never delete unknown/user content merely because it is large.
6. Use exact paths and bounded batches.
7. Re-read disk usage after each meaningful cleanup group.
8. Preserve a factual list of removed paths/categories and recovered space when available.

## Safety

Source files, saves, credentials, documents, VM images, databases, and arbitrary downloads are not cleanup targets without explicit evidence. Size is not a moral failing.
