---
name: performance-triage
description: Diagnose CPU, memory, disk, process, and network bottlenecks from bounded snapshots before changing performance settings.
version: 1.0
requires: machine.health, machine.snapshot, process.list
platforms: any
mutation: read-only
privilege: user
trust: trusted
tags: performance, cpu, memory, disk, diagnostics
---

# Performance Triage

Use this workflow when a machine or application is slow, stuttering, saturated, or unexpectedly resource-heavy.

## Workflow

1. Capture `machine.health` first so CPU, memory, and disk pressure are measured before intervention.
2. Capture `machine.snapshot` for platform/runtime context.
3. Inspect `process.list` and correlate high resource use with expected workloads.
4. Decide which bottleneck class has evidence:
   - CPU saturation
   - memory pressure/paging
   - disk space or I/O pressure
   - process runaway/hang
   - network dependency latency
5. Collect one additional bounded diagnostic for the leading class rather than shotgun-running every tool.
6. Compare multiple samples when the complaint is intermittent.
7. Preserve workload context such as build, game, model training, browser load, or background service before interpreting utilization.
8. Recommend or perform mutations only in a separate, explicit workflow after the bottleneck is verified.

## Safety

- High utilization alone is not a fault if useful work is progressing.
- Do not kill the top CPU process solely because it is top CPU.
- Do not clear caches, disable services, or change power settings as a diagnostic shortcut.
- This skill is deliberately read-only.
