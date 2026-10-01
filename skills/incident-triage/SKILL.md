---
name: incident-triage
description: Triage a degraded host or service with bounded read-only evidence before choosing any repair path.
version: 0.1
requires: machine.health, process.list, network.dns.resolve, network.tcp.probe, network.http.probe
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: incident, triage, diagnostics, network
---

# Incident Triage

Use this skill at the start of an outage, severe slowdown, or unexplained service failure.

## Workflow

1. Record current time and the exact reported symptom.
2. Read compact machine health.
3. Inspect relevant managed process/session state.
4. Probe only the network layers that matter: DNS, TCP, then application HTTP.
5. Separate local resource pressure, process failure, name resolution, transport failure, and application-level failure.
6. Prefer evidence from current structured state over assumptions from old logs.
7. Produce a short diagnosis with confirmed facts, uncertain hypotheses, and the next minimal diagnostic action.
8. Hand off to a mutation-capable repair skill only after the failing layer is identified.

## Safety

Triage is read-only. Do not restart services or delete state just because the pager is loud.
