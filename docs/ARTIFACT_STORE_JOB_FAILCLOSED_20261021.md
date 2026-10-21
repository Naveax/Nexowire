# Nexowire Artifact Store/Job fail-closed acceptance, 21 October 2026

## Verified lineage

Parent PR #596 is OPEN/DRAFT, exact accepted HEAD 335046569a38f3a1a3fc82bf851f9b7df7640fdb, CI 39557944551 SUCCESS. Independent QA #597 is MERGED into the parent. Main 37d68d938b9c94b8647b92fb592a2b30c075427c contains #601 quota/cancellation fencing. This isolated worktree branches from #596 and merges current main INTO THE WORKTREE ONLY. PR #605 is OPEN/DRAFT connection continuity, not a merged checkpoint adapter. #587 P0 journal and authority co-rollback remains OPEN.

## New implementation

- src/workspace/artifact-job-trust.ts defines trusted Hub-only injection for rollback-independent monotonic CAS authority. Local PID/SQLite file locks are NOT a trust root. Each job receives an epoch/token not controlled by MCP callers.
- CrossDeviceTransferJobs checks the independent lease before EVERY remote 64KiB chunk write and final atomic publication, and demands a higher epoch on explicit resume. It rejects missing, stale, revoked or unavailable external authority. Production MCP explicitly enables requireExternalAuthority, so unconfigured hosted services DO NOT dispatch mutations. A staging-only authority emulator is injected in isolated loopback tests.
- src/workspace/artifact-job-budget-staging.ts connects server-derived owner/device/project identity to already merged #601 StagingArtifactByteBudget: reserve, exact-offset cancellation tombstone, and release only after independently attested physical deletion PLUS in-flight writer fence. Never trusts caller-supplied booleans and never refunds on cancellation alone. This staging adapter is NOT wired into production billing, quota dispatch or Agent file writes.
- src/workspace/artifact-job-checkpoint.ts only emits cross-chat checkpoint when a truly verified content-addressed Artifact manifest agrees with completed job account/device/project, SHA-256, file size, repository and commit; mere remote completed status is rejected. The existing Artifact Bridge checkpoint store provides persistence.
- No changes to Agent journal #587 source, #05 Native offsets/USB, #06 / #605 connection continuity, or already merged #601 ledger.

## Exact local tests

Disposable synthetic tests on Work PC: no external authority rejects mutating job start (zero writes); simulated external monotonic highwater greater than co-rolled-back local journal fails explicit resume; #601 cancellation tombstone retains quota until trusted writer-fenced deletion and prevents re-begin; checkpoint adapter rejects fake COMPLETED, wrong digest or owner scope and allows verified artifact only. Earlier independent sandboxed two-Agent WebSocket test now supplies an explicitly TEST-ONLY external authority emulator. Selected original + negative suites: 112/112 PASS; typecheck, build and continuation checks PASS on the merged isolated worktree. No 1GiB file was created or transferred in this turn.

## Physical, staging and production gates

SOURCE PASS only. ISOLATED STAGING PASS for fixture invariants, but real external monotonic CAS authority and #601 trusted per-chunk receipts are NOT deployed. Real #587 co-rollback acceptance requires an independent authenticated remote trust root and fails closed when unavailable; a separate SQLite directory is insufficient. Production owner/global quota, write-fence, post-cancel retention and disk pressure still require trusted integration. #605 is a different DRAFT connection continuity proposal; its unmerged modules are not claimed active. PHYSICAL NO-GO: both running Naveax/Work PC Agent 1.0.5 remain unchanged and >256MiB Native offsets remain unproven. PRODUCTION NO-GO pending multi-host lease/fencing, journal rollback proof, staging signed WAN/TLS and QA #16 / integration #00. Do not merge or deploy this DRAFT automatically.
