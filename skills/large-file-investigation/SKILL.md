---
manifest_version: 2
name: large-file-investigation
description: Find what is consuming disk space with bounded filesystem inspection, distinguish disposable artifacts from user data, and prepare safe cleanup candidates.
version: 1.0
requires: files.list, files.stat, search.text
platforms: any
mutation: read-only
privilege: user
trust: trusted
tags: disk, files, cleanup, diagnostics
concurrency: parallel-safe
replay: safe
---

# Large File Investigation

Use this workflow before any disk cleanup so deletion decisions are based on evidence.

## Workflow

1. Start with the reported filesystem/root and confirm the native-agent allowlist boundary.
2. Use bounded directory listings and stats to identify large top-level candidates.
3. Drill down only into the largest relevant directories.
4. Classify candidates:
   - build/cache artifacts that can be regenerated
   - logs/dumps
   - package/download caches
   - duplicate/redundant artifacts
   - application state
   - unique user data
5. When names are insufficient, inspect bounded metadata or targeted text signatures rather than opening large binary files.
6. Produce cleanup candidates with size, path, regeneration confidence, and risk.
7. Hand actual deletion to a mutation workflow after explicit target selection and verification.

## Safety

- This skill is read-only.
- Never label a file disposable only because it is old or large.
- Do not recursively enumerate the entire disk when bounded top-down inspection will answer the question.
- Build outputs and caches may still contain the only copy of an artifact; verify provenance before deletion.
