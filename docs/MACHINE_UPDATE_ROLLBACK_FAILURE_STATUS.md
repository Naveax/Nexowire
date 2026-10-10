# Fail-closed machine update rollback reporting

When a versioned Hub/Broker cutover fails, the generated privileged recovery script must not claim `rolled_back` when copying original launchers or restarting scheduled tasks also fails. Previously rollback used `-ErrorAction SilentlyContinue` for task restarts and did not verify restored launcher bytes. The status could report success even if a broken service or corrupted launcher remained.

## Changes

- During rollback, collect distinct Hub/Broker stop errors, launcher restoration errors, and Hub/Broker restart errors. Continue attempting the other recovery operations rather than stopping at the first failure.
- Restore launcher files with `Copy-Item -ErrorAction Stop` and verify restored files against the backup SHA-256 (`Get-FileHash`). Restore errors are surfaced rather than hidden.
- If any recovery operation fails, write status `rollback_failed` with both original cutover failure and all recovery failures, exit code 2. Only when all attempted recovery operations report success, write the existing `rolled_back` status and exit code 1.
- The normal success path, task principals/action preflight, port/PID/executable matching, staged runtime and root ACL checks remain unchanged.

## Work-pc verification

29/29 focused tests pass on real Windows PowerShell 5.1 and TypeScript, including five isolated mocked failure modes (clean rollback, restore failure, Hub restart failure, Broker restart failure, simultaneous stop/restore/restart errors) plus a true disposable original-launcher backup/restore and SHA-256 comparison. Existing machine task principal and task-plan tests passed; npm typecheck/build/diff passed.

## Boundaries

These tests use disposable launcher files and mocks; no real production Scheduled Task was stopped or started. A successful rollback status still means only that restoration and restart commands returned successfully. Independent old-runtime listener/health checks and live administrator-authorized OAuth/DPAPI/Highest Task Scheduler rollback remain required. This source-only improvement does not close P0 #271 or repair the current writable elevated legacy Stack.