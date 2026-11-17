# Reviewed portable CORE authority test coverage — 2026-11-17

## Scope and source evidence

- Parent source: integration #1160 at `198da5e6d8f9abfc58935e7b956af123b00ac3e5`.
- Source tree inventory: 649 tracked TypeScript `.test.ts` files: 574 root, 42 one directory below `test/`, 33 deeper. These are **discovery counts**, not test execution evidence.
- Newly reviewed entrypoint: `test/core-elevation-effective-truth-matrix.test.ts`, Git blob `09d970538d6ce22b20edb25c9da1fcbed8929c4c`. Its 10 isolated tests passed on a development Windows user session.
- The source-only import closure is `test/core-elevation-effective-truth-matrix.test.ts` -> `src/security/authorization-explain.ts` (`a916ba1cffb24472d533630ceceb93febc8c46e2`) -> `src/security/privilege.ts` (`64c79bd868e43448ecb34d9bc83624282b04b5c7`). It uses `node:test` and `node:assert/strict`; no external process execution, browser, filesystem mutation, network listener, Windows scheduled task, or privileged token is exercised.
- This test checks that owner CORE preference, a 15-minute ROOT lease and Broker-ready telemetry **cannot** prove a live elevated token, UAC or bound physical console authorization, including expiration and identity-mismatch boundaries.

## Review and remaining gap

- Explicit portable-root allowlist: **30 files** after review, up from 29.
- Source-only unreviewed queue: **619 files** if the tracked inventory remains 649; these are neither approved nor represented as PASS.
- The SHA-bound portable receipt runner still executes each approved file separately and requires zero FAIL/SKIP/TODO/CANCELLED with an exact TAP summary, bounded subprocess runtime, and Git blob identity verification.
- The original `npm test` Bash `test/**/*.test.ts` pattern is still incomplete and **does not** establish full repository test execution (#1205). The historical 635/29/606 numbers in the experimental release notes describe an older commit, not the current source.
- Native Windows Job, SYSTEM Hub, DPAPI, Broker, SQLite physical migration and two-device acceptance remain independent NO-GO gates. This portable source-only review does not alter installed Work-PC services or imply a stable release.

The new SHA must pass exact-head hosted Node 22/24 portable-root inventory and CI checks before it is treated as accepted.
