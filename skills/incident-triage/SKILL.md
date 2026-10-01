---
manifest_version: 2
name: incident-triage
description: Triage a degraded host or service with bounded read-only evidence before choosing any repair path.
version: 0.1
requires: machine.health
requires_any: process.list | windows.processes; network.dns.resolve | shell.exec; network.tcp.probe | shell.exec; network.http.probe | shell.exec
prefers: process.list, windows.processes, network.dns.resolve, network.tcp.probe, network.http.probe
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: incident, triage, diagnostics, network
concurrency: parallel-safe
replay: safe
---

# Incident Triage

Use this skill at the start of an outage, severe slowdown, or unexplained service failure.

## Workflow

1. Record current time and the exact reported symptom.
2. Read compact machine health.
3. Prefer structured managed/system process state; use the available process-view alternative rather than making the workflow platform-specific.
4. Prefer structured DNS/TCP/HTTP probes for the network layers that matter; use bounded shell fallbacks only when a required structured probe is unavailable.
5. Separate local resource pressure, process failure, name resolution, transport failure, and application-level failure.
6. Prefer evidence from current structured state over assumptions from old logs.
7. Produce a short diagnosis with confirmed facts, uncertain hypotheses, and the next minimal diagnostic action.
8. Hand off to a mutation-capable repair skill only after the failing layer is identified.

## Safety

Triage is read-only. Do not restart services or delete state just because the pager is loud.
