---
name: machine-bootstrap
description: Configure a development or worker machine reproducibly from inspected current state while minimizing global and privileged changes.
version: 0.1
requires: machine.snapshot, machine.health, shell.exec, files.stat, files.write
platforms: any
mutation: mutation
privilege: user
trust: reviewed
tags: machine, bootstrap, setup, environment
---

# Machine Bootstrap

Use this skill when preparing a machine for a known workload.

## Workflow

1. Snapshot OS, architecture, runtime/tool versions, disk, and existing configuration.
2. Define the smallest required toolchain from the workload rather than installing a generic universe of developer software.
3. Prefer user-scoped/package-manager installations where they meet the requirement.
4. Keep machine-specific secrets outside committed files.
5. Make configuration changes explicit and idempotent where possible.
6. Verify each runtime/tool immediately after installation.
7. Run one representative workload or project check.
8. Save a checkpoint describing exact installed components, versions, and remaining manual prerequisites.

## Safety

Do not elevate merely because setup scripts traditionally do. Separate user-level setup from genuinely privileged system changes.
