---
name: verify-before-finish
description: Verify the real post-change state before reporting a computer-control task as complete.
version: 0.1
requires: machine.snapshot
---

# Verify Before Finish

Completion requires evidence.

- code: typecheck/build/tests and Git diff
- process: process exists and remains alive long enough to be useful
- service: service reports the intended state
- file: expected path/content/hash exists
- network: endpoint or route is reachable
- GUI: the expected window or state is observable
- WSL: the command ran in the intended distro

Unknown is not pass. A timeout, disconnect, or lost result must be recorded as unknown.
