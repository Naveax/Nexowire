# NX AI-08 | Windows Hub Boot fixture source acceptance (2026-11-24)

Base integration #1160: `b04bf428dd9cedc1a765d9194c17eb0c80df97c0`.
Related #1205, #1161, and AI-01 Draft #1242.
Source-only / Draft / NO-GO. No production Windows mutation.

## Prior source acceptance

AI-08 #1248 `9dcd52617f91ec7ddeb6075554083087b1359560` is still a separate Draft based on the same integration SHA; CI #45202887514 attempt 2, Release Readiness #45202887641, Portable Root #45202887756, and Test Discovery #45202887750 all SUCCESS. That Draft does not modify Release Readiness and is not a prerequisite for this change. No merge, stable tag or release is authorized by those results.

## Review scope and two coherent test fixture profiles

AI-01 requested explicit Windows-hosted execution of four root tests and the upcoming startup-trigger regression in #1205. Existing portable Linux receipts cannot establish Windows-only PowerShell case execution. The reviewed files use source reads, pure validation calls, or synthetic PowerShell task objects and temporary process environment. They do not install, stop, remove or register actual Windows tasks. The lane is restricted to disposable GitHub-hosted Windows runners and must not be run against Work-PC.

Baseline test file pins at b04bf428:

| Test file | Reviewed Git blob SHA |
| --- | --- |
| test/hub-boot-status-legacy-user.test.ts | 66d93e212bce277217b3a2cbc027251ed7c73c00 |
| test/hub-boot-task-shell-trust.test.ts | 6dc4e0a7da26bf3dc02877174688448d6348822d |
| test/hub-boot-root-boundary.test.ts | d6e564dd581e9dce198afc2b94c2c36ebda56a11 |
| test/hub-boot-handoff-transaction.test.ts | 2c700196272174cdfdc84ecc953365d2946d275f |

Separately reviewed AI-01 Draft #1242 at `ebeadc0a7708f8d67f2ee0c6afbbb5646878d2db`:

| Test file | Reviewed Git blob SHA |
| --- | --- |
| test/hub-boot-status-legacy-user.test.ts | 800ca3e6bc6b892c26f102ec7f250754cc1372f3 |
| test/hub-boot-task-shell-trust.test.ts | ce31e6c39b63647c5bb11e579262690694829b12 |
| test/hub-boot-root-boundary.test.ts | dee621f126f5b132cd0f25de8cb7469df244833c |
| test/hub-boot-handoff-transaction.test.ts | 8ad2c05bfe6c08ceae3e15792d493099e44ec20d |
| test/hub-boot-startup-trigger-integrity.test.ts | 61062ecab51d2852c750cccd03fae79f7b45286a |

The two modified task fixture files add synthetic enabled AtStartup and empty action working-directory properties; the root-boundary file adjusts a source assertion; the handoff file adds a readback-before-stop source assertion. The new file exercises standalone launcher validation and synthetic PowerShell trigger/ambient-environment cases. A future change to any of these blobs requires another source review; profiles must not be mixed.

## Implementation

- Release Readiness explicitly triggers on all five paths (the startup file is not yet present on baseline) and TAP summary verifier changes.
- Independent Windows-hosted job runs Node 22 and 24 against exact PR HEAD, disables checkout credential persistence, validates Git inventory and reviewed file bytes, and invokes each reviewed test separately with `node --test --test-reporter=tap --import tsx --test-concurrency=1 <file>`.
- Wrong platform, changed file bytes, missing expected SHA, child timeout/nonzero status, skipped/failed/cancelled/TODO or incomplete TAP output fail the job. Success emits one machine-readable receipt containing exact source SHA, manifest, reviewed profile, platform, per-file blob and counters, executed count and remaining NOT_RUN count **for this lane only**. An interrupted lane must not be represented as a successful receipt.
- Release package jobs require both existing AI-08 receipt verification and the Windows fixture lane, preserving the existing package -> attest -> publish relationship. Original CI workflow and three provenance matrices remain byte-for-byte untouched.

## Acceptance status

Until matching child runs complete, both Node versions are PENDING. The baseline profile covers four files only. The fifth startup test is NOT_RUN on this base because its source is not yet integrated. No new physical Windows boot/WSS, SYSTEM token, real DPAPI/Broker, SQLite, or two-PC execution is implied by this source-only lane. The wider 654-file execution remains unproven.

Rollback: revert only Release Readiness, its release path MJS contract, and this document in the AI-08 child. Coordinate AI-01 source evolution and exact blobs before promoting either branch. No main commit, release, tag or production action.
