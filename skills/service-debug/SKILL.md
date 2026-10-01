---
name: service-debug
description: Diagnose Windows service startup, dependency, process, network, and event-log failures before applying verified service changes.
version: 0.1
requires: machine.health, windows.services, windows.processes, windows.network.snapshot, windows.eventlog.query, windows.service.control
platforms: win32
mutation: mixed
privilege: user
trust: reviewed
tags: windows, service, diagnostics, eventlog
---

# Service Debug

Use this skill for a Windows service that will not start, repeatedly stops, or behaves differently from its owning process.

## Workflow

1. Read the exact service record and current state.
2. Correlate its PID with the structured process view.
3. Inspect recent bounded event-log entries relevant to the service/application.
4. Check network state only when the service actually depends on ports/routes/DNS.
5. Identify startup type and dependency problems before changing anything.
6. Apply start/stop/restart/startup-type mutations only to the exact service.
7. Re-read service state and PID after mutation.
8. Verify the intended application-level postcondition, not merely that SCM reports `Running`.

## Safety

A running service can still be unhealthy, and stopping the wrong one can remove networking or remote access. Exact names and post-verification are mandatory.
