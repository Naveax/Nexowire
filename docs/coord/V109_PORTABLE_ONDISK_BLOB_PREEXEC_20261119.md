# Portable root execution: on-disk Git blob validation (2026-11-19)

Parent `4802faa06edca1f531a52cac56476d6b8573df91` (test-review PR #1228). The pre-execution allowlist pins the committed Git tree, but the runner formerly did not compute a Git blob hash over the *on-disk bytes* of the selected test file. A checkout modified between the inventory's Git diff check and a child process launch could pass the filename/tree admission without matching the approved test body.

This patch computes `SHA1("blob " + byteLength + NUL + rawBytes)` for each of the 33 allowlisted files before spawning **any** child process and checks each test file again immediately before its subprocess. It requires a regular, non-symlink source file. Isolated injected-reader negative fixtures verify both a pre-start unreviewed replacement and a simulated change between test launches; no actual repository or production files are modified by the fixtures.

This closes the missing *on-disk content attestation at read time*, not the final file-read/process-exec time-of-check/time-of-use window. Complete atomic execution would require a trusted, immutable isolated checkout or snapshot. The change does not expand the approved list, change `npm test` discovery, cover all 650 tests, or assert physical SYSTEM acceptance.
