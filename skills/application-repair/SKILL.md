---
name: application-repair
description: Repair a broken local application by separating process, configuration, dependency, service, and filesystem causes before mutation.
version: 0.1
requires: machine.health, process.list, files.stat, files.read_many, search.text, shell.exec
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: application, repair, diagnostics, recovery
---

# Application Repair

Use this skill when an installed application no longer launches or behaves correctly.

## Workflow

1. Capture the exact failure and application version/path.
2. Check machine pressure and duplicate/stale processes.
3. Inspect bounded logs/configuration and recent relevant changes.
4. Separate executable/dependency failure from user configuration, permissions, network, or service dependencies.
5. Prefer reversible repair: regenerate caches, repair a known dependency, restore a verified config value, or reinstall only the affected component.
6. Preserve user data unless deletion is explicitly required and backed up.
7. Relaunch the exact application and verify the original symptom.
8. Record what changed and how the repair was verified.

## Safety

Never turn "repair" into deleting every application directory and hoping the installer performs necromancy. User data, credentials, and profiles are separate assets.
