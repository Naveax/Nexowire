---
manifest_version: 2
name: service-readiness-audit
description: Prove whether an already-running service is locally healthy and reachable using process, machine, TCP, DNS, and optional HTTP evidence without changing service state.
version: 0.1
requires: machine.health, process.list, network.tcp.probe
prefers: network.dns.resolve, network.http.probe
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: service, readiness, process, tcp, http, health
concurrency: parallel-safe
replay: safe
---

# Service Readiness Audit

Use this skill to answer "is the service actually ready?" without restarting it, changing configuration, or mistaking a process for a healthy endpoint.

## Workflow

1. Read machine health to rule out obvious local resource exhaustion.
2. Inspect the managed process list for the expected service/process identity.
3. Resolve the hostname when DNS is part of the route.
4. Probe the exact TCP host/port.
5. For HTTP(S) services, probe the narrowest readiness/health endpoint available.
6. Correlate evidence instead of collapsing everything into one boolean:
   - process absent
   - process present but port closed
   - TCP reachable but HTTP unhealthy
   - HTTP healthy while local process identity is unexpected
7. Record timestamps and target endpoints so later comparisons do not confuse stale evidence with current readiness.

## Replay and concurrency

The workflow is read-only. Machine, process, DNS, TCP, and HTTP reads may run concurrently when they do not depend on a hostname discovered by an earlier step. Replaying the audit is safe.

## Rules

- Do not start, stop, restart, or repair the service in this workflow.
- A listening port is not equivalent to application readiness.
- An HTTP 200 from the wrong endpoint is not proof of the intended service.
- Prefer explicit readiness endpoints over broad homepage checks when available.
