---
name: wsl-workflow
description: Work correctly across Windows and WSL2, including distro selection, paths, shells, and verification.
version: 0.1
requires: wsl.exec, machine.snapshot
---

# WSL Workflow

1. Inspect the machine snapshot to determine whether WSL distributions are installed.
2. Select an explicit distribution when more than one is available.
3. Keep Windows and Linux paths distinct.
4. Prefer the Linux-native toolchain inside WSL for Linux builds.
5. Capture distro, cwd, command, exit code, stdout, and stderr.
6. Verify artifacts from the environment that created them.

If WSL2 is installed but no distribution exists, report that exact state rather than pretending WSL execution is ready.
