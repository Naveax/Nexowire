---
manifest_version: 2
name: configuration-drift-audit
description: Verify an explicit live configuration file set against a trusted baseline using bounded metadata and SHA-256 evidence without mutating configuration or reading secret payloads unnecessarily.
version: 0.1
requires: files.stat, files.hash
prefers: files.read_many, search.text
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: configuration, drift, baseline, hash, audit
concurrency: parallel-safe
replay: safe
---

# Configuration Drift Audit

Use this skill when a known configuration baseline exists and you need to determine whether the live files still match it before a deployment, restart, incident response, or recovery action.

## Workflow

1. Identify the exact live configuration paths and one explicit trusted baseline. The baseline may be user-supplied hashes/metadata or a small checksum/manifest file.
2. Stat only the expected live paths and record missing files, unexpected object types, sizes, and modification times.
3. Hash integrity-relevant files with `files_hash`. Independent files may be hashed in parallel within normal I/O bounds.
4. Compare current SHA-256 values with the explicit baseline. Classify each path as `matched`, `changed`, `missing`, or `unverified`.
5. If the baseline is stored in a small local manifest, use `files_read_many` only for that metadata. Do not read live configuration bodies merely to prove hash equality.
6. Use `search_text` only when the task explicitly requires checking a non-secret expected directive and hash equality alone cannot answer it.
7. Report the exact path, expected/current metadata, evidence source, and any verification gap before proposing a separate remediation workflow.

## Replay and concurrency

This workflow is read-only and safe to replay. Stat/hash work for independent configuration files may run concurrently when it does not exceed normal I/O limits.

A repeated audit produces fresh evidence. Do not reuse earlier hashes after configuration may have changed.

## Rules

- Never invent the baseline. Without a trusted expected value, report that drift cannot be proven.
- Do not modify, patch, copy, delete, reload, or restart anything in this workflow.
- Prefer hashes and metadata over reading configuration contents.
- Treat configuration as potentially secret-bearing. Do not expose tokens, passwords, private keys, connection strings, or unrelated payload text.
- Matching size or mtime is not proof of equality when a baseline hash is available.
- Distinguish `changed` from `unverified`; a bounded hash failure is not evidence of drift.
