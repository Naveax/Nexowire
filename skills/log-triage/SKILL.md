---
name: log-triage
description: Reduce large application or system logs into a bounded timeline, recurring signatures, first-cause candidates, and reproducible next diagnostics.
version: 1.0
requires: files.read, files.stat, search.text
platforms: any
mutation: read-only
privilege: user
trust: trusted
tags: logs, diagnostics, incidents, search
---

# Log Triage

Use this workflow when the available evidence is primarily one or more text logs.

## Workflow

1. Stat the relevant files before reading so size and recency are known.
2. Prefer targeted `search.text` queries for error levels, exception names, request IDs, process IDs, timestamps, and known symptoms.
3. Read bounded surrounding ranges around the earliest relevant failure, not just the final repeated error.
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
