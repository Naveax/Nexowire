---
name: port-conflict
description: Diagnose which process owns a TCP port, verify expected listeners, and resolve development or service port collisions with minimal mutation.
version: 1.0
requires: process.list, network.tcp.probe, shell.exec
platforms: any
mutation: mixed
privilege: user
trust: trusted
tags: networking, ports, diagnostics, processes
---

# Port Conflict

Use this workflow when a server cannot bind, a development port appears occupied, or traffic reaches the wrong local process.

## Workflow

1. Confirm the exact host, port, protocol expectation, and intended service before changing anything.
2. Probe the port with `network.tcp.probe` to distinguish listener absence from application-level failure.
3. Inspect running processes with `process.list`.
4. Use the platform shell only for the smallest missing ownership detail:
   - Windows: structured process/network tools first, then a bounded `Get-NetTCPConnection` query if needed.
   - Linux/macOS: bounded `ss`, `lsof`, or equivalent read-only inspection.
5. Correlate PID, executable, working context, and expected application before treating the listener as a conflict.
6. Prefer reconfiguring the intended application's port when another legitimate service owns the port.
7. Stop a process only when its identity and ownership are established and doing so matches the user's goal.
8. Re-probe after mutation and verify that the expected process, not merely any process, now owns or serves the port.

## Safety

- Never kill by port number alone.
- Do not terminate system services merely because a desired development port is occupied.
- Treat TIME_WAIT and transient sockets differently from persistent LISTEN state.
- A successful TCP connect proves reachability, not application correctness.
- When the process identity is ambiguous, report the conflict instead of mutating.
