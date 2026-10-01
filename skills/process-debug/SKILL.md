---
name: process-debug
description: Diagnose process failures and hangs from structured state, bounded output, ownership, ports, and verified lifecycle changes.
version: 0.1
requires: machine.health, process.list, process.read, process.start, process.stop, windows.processes, windows.network.snapshot
platforms: win32
mutation: mixed
privilege: user
trust: reviewed
tags: process, debug, hang, windows
---

# Process Debug

Use this skill for crashed, hung, duplicate, or unexpectedly resource-heavy Windows processes.

## Workflow

1. Read compact machine health first to distinguish local process failure from system-wide pressure.
2. List Nexowire-managed sessions and structured Windows processes.
3. Correlate PID, parent/child relationships, command ownership, service association, and listening connections when relevant.
4. Read incremental output with cursors rather than retransmitting the entire process log.
5. Reproduce with the smallest bounded command when safe.
6. Stop or restart only the exact identified process/session, never a wildcard family by default.
7. Re-read process and network state after mutation.
8. Preserve diagnostic evidence in task metadata, not secret-bearing full command payloads.

## Safety

Unknown process state is not permission to kill it. Verify PID identity immediately before destructive lifecycle operations.
