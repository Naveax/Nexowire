---
manifest_version: 2
name: log-triage
description: Reduce large application or system logs into a bounded timeline, recurring signatures, first-cause candidates, and reproducible next diagnostics.
version: 1.0
requires: files.stat, search.text
requires_any: files.read_many | files.read
prefers: files.read_many
platforms: any
mutation: read-only
privilege: user
trust: trusted
tags: logs, diagnostics, incidents, search
concurrency: parallel-safe
replay: safe
---

# Log Triage

Use this workflow when the available evidence is primarily one or more text logs.

## Workflow

1. Stat the relevant files before reading so size and recency are known.
2. Prefer targeted `search.text` queries for error levels, exception names, request IDs, process IDs, timestamps, and known symptoms.
3. Prefer batched bounded reads when multiple known logs are involved; fall back to single-file reads when batching is unavailable. Read surrounding evidence around the earliest relevant failure, not just the final repeated error.
4. Build a chronological chain from normal state to first anomaly to downstream failures.
5. Group repeated messages by normalized signature rather than counting every line as independent evidence.
6. Distinguish:
   - first-cause candidate
   - secondary cascade errors
   - retries/noise
   - shutdown artifacts
7. Cross-check timestamps across files before claiming causality.
8. End with the smallest diagnostic or fix that can confirm or falsify the leading explanation.

## Safety

- Do not stream entire multi-gigabyte logs into model context.
- Redact or avoid secrets, tokens, cookies, authorization headers, and personal data when not necessary.
- "Last error in the file" is not equivalent to root cause.
- Preserve original files; this workflow is read-only.
