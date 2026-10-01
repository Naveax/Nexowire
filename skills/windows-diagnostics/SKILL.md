---
name: windows-diagnostics
description: Diagnose Windows process, service, and network state using structured Nexowire tools before falling back to shell text parsing.
version: 0.1
requires: windows.processes, windows.services, windows.network.snapshot, windows.registry.read, windows.tasks, windows.eventlog.query, windows.firewall.rules, windows.registry.set, windows.registry.delete, windows.task.control, windows.firewall.control
platforms: win32
mutation: mixed
privilege: user
trust: reviewed
tags: windows, diagnostics, service, registry, firewall
---

# Windows Diagnostics

Use this skill for Windows host troubleshooting.

## Workflow

1. Start with a compact machine snapshot.
2. Query structured process or service state rather than parsing tasklist, sc.exe, or formatted PowerShell tables.
3. Use the network snapshot for adapters, preferred IPs, DNS, default routes, and only include TCP connections when the task needs them.
4. Use registry, scheduled-task, event-log, and firewall queries before falling back to ad-hoc PowerShell text parsing.
5. Correlate service process IDs with the process view when diagnosing crashes or port ownership.
6. Use shell execution only for a detail that the structured tools do not yet expose.
7. After a service mutation, re-read the structured service state before considering the operation complete.

## Safety

Service start/stop/restart and startup-type changes can interrupt applications or networking. Apply them only to the explicitly requested service and preserve the verified final state in the task record.

## Mutation rules

- Use mutation tools only with exact names/paths, never wildcard selectors.
- Registry writes and deletes must be followed by the returned verification result.
- Task and firewall controls re-read final state; treat a failed verification as an incomplete operation, not success.
- Prefer read-only diagnosis before mutation.
