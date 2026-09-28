---
name: build-and-test
description: Build and test a project using the smallest useful feedback loop before escalating to the full suite.
version: 0.1
requires: workspace.snapshot, shell.exec
---

# Build And Test

1. Detect the project/build system from repository markers.
2. Run static or type checks that cover the modified area.
3. Run the narrowest relevant tests first.
4. Fix deterministic failures before widening the test scope.
5. Run the full regression suite when focused checks are clean or before release-quality completion.
6. Record exact commands and outcomes in the workspace checkpoint.

Never claim a suite passed when a process disconnected, timed out, or produced an unknown final status.
