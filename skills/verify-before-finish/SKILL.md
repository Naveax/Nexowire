---
manifest_version: 2
name: verify-before-finish
description: Verify the real post-change state before reporting a computer-control task as complete.
version: 0.1
requires: machine.snapshot
prefers: workspace.detect, workspace.checks, process.list, files.stat, files.hash, network.tcp.probe, network.http.probe, windows.window.list, windows.screenshot
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: verification, postcondition, safety
concurrency: parallel-safe
replay: safe
---

# Verify Before Finish

When a workspace exposes structured checks, call `workspace.detect` first and prefer `workspace.checks` for the relevant test/build/lint/typecheck commands.

Completion requires evidence.

- code: typecheck/build/tests and Git diff
- process: process exists and remains alive long enough to be useful
- recovered process session: distinguish interactive, exited, lost, and orphaned states
- service: service reports the intended state
- file: expected path/content/hash exists
- network: endpoint or route is reachable
- GUI: the expected window or state is observable
- WSL: the command ran in the intended distro

Unknown is not pass. A timeout, disconnect, or lost result must be recorded as unknown.
