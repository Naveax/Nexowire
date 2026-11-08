# AI-06 exact-SHA release QA ledger | 2026-11-08

Decision: **NO-GO**. QA changes only; no production source, live Hub/Agent/Broker/SQLite, NAVEAX, VM or updater modified.

## Git identity

- Repository: Naveax/Nexowire. Main: `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.
- Draft PR #1096 original HEAD: `43e8125e7a4ced654a769b661dc10938c02bc7a4`.
- QA worktree: `agent/ai06-release-qa`; begins at that HEAD. Own new commit must have independent CI.
- Existing runs only. No rerun or duplicate dispatch.

| Workflow | Run | Result at observed original HEAD |
|---|---|---|
| CI | [42517451677](https://github.com/Naveax/Nexowire/actions/runs/42517451677) | RUNNING: browser-live / DPAPI-prelogin pending |
| Release Readiness | [42517451658](https://github.com/Naveax/Nexowire/actions/runs/42517451658) | PASS: Linux, Windows, macOS package |
| Connection v2 Relay QA | [42517451820](https://github.com/Naveax/Nexowire/actions/runs/42517451820) | PASS: Windows/Linux on Node 22/24 |
| Atomic No-Replay | [42517451686](https://github.com/Naveax/Nexowire/actions/runs/42517451686) | PASS: Windows Node 22/24 |

All four run HEADs match `43e8125...`. Do not transfer this conclusion to any newer SHA. Optional workflow steps with SKIP remain SKIP, not PASS.

## Windows setup, Unicode and EBUSY

On original exact HEAD, Windows package job steps **PASS**: one-click setup smoke, bundled Windows WAL restart, corrupt-download denial, published 1.0.7 ASCII baseline, anonymous GitHub bootstrap with Unicode profile. Commit `43e8125...` changed cleanup in `scripts/smoke-windows-user-setup.ts` to use Node `fs.rm` with `maxRetries:12` and `retryDelay:100`, preserving failure on persistent errors. Actual transient-lock fault-injection remains **NOT_RUN**; hosted smoke success is not proof that EBUSY was triggered.

## New QA tests and source preservation

- `test/coord/ai06-release-evidence.ts` and `ai06-release-evidence.test.ts`: verify exact 40-hex SHA, run/job identity and mandatory jobs, duplicate/missing checks, PASS/FAIL/SKIP/NOT_RUN/RUNNING, source and physical receipt existence. Offline snapshots can only become READY_FOR_MANUAL_SIGNOFF; they never automatically authorize production GO.
- `test/coord/ai06-source-preservation.test.ts`: 243-row matrix compared to real committed `git ls-tree -r -z HEAD` blobs, with path agreement and classification checks.
- Existing 79-row `test/connection-v2-release-gate/source-preservation.test.ts` remains enabled.
- New 243-row test initially FAILED and identified 2 stale candidate blobs. Exact Git tree validated both changes:
  1. `test/qa-core-claim-readiness-race-p11.test.ts`: candidate `ac0f3e1954b94a995ecc4819ad5528861df5943b` -> `28e2a20fb1fec4eef6405981c87a26eea1c4ca43`. Original-to-candidate diff only adds migration `0021_core_console_native_claim_verified.sql` to fixture. Downgraded false EXACT_SOURCE_BLOB to EVOLVED; semantic review is still required.
  2. `docs/connection-v2/source-preservation-matrix.csv`: candidate `3a13e9877c10405a23f8cc0aa68666f9b5491b43` -> `12cd62f4772a6d9f976653f813c7dc1c9c47b293`; remains EVOLVED.
- Only those two candidate hash cells and one classification changed in `docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv`. All original source IDs and 243 rows preserved.
- Focused tests after change **13/13 PASS** (10 QA, 1 new 243-row, 2 old 79-row). `npm run typecheck`, `npm run build`, `git diff --check` PASS locally. These are not exact-new-commit hosted CI results.

## Mandatory release matrix (hosted and physical separate)

| Area | Hosted/source result at original integration SHA | Physical candidate evidence |
|---|---|---|
| SYSTEM Hub boot | Windows DPAPI/Hub contracts PASS | **NOT_RUN**: SYSTEM startup without user login, trusted Program Files and ProgramData ACL |
| Pre-login Agent | Hosted DPAPI/pre-login tests PASS | **NOT_RUN**: LocalMachine DPAPI enrollment + handoff after login |
| CORE/Broker | Windows Broker admission CI PASS | **NOT_RUN** for candidate: elevated real command, CAS/ACK, two devices; prior Administrator=false unresolved |
| SQLite durability | Bundled Windows WAL restart PASS | **NOT_RUN**: VM power loss, rollback, cold restart on exact release |
| Connection v2 | Relay QA 4 platform/Node cases PASS | **NOT_RUN**: Cloudflare-independent recovery after actual network loss |
| Cloudflare external | Source integration previously tested | **NOT_RUN**: real external ingress/reconnect |
| Unicode-profile setup | Hosted Windows one-click step PASS | **NOT_RUN**: production machine rollout |
| EBUSY cleanup | Source fix present + Windows smoke PASS | **NOT_RUN**: deterministic transient EBUSY injection |
| VM reboot + hard-off | Hosted process restart is not equivalent | **NOT_RUN** |
| Official signed update/rollback | CI packaging does not prove installed rollback | **NOT_RUN** |

Historical Work-PC SQLite and CORE receipts refer to a hotfixed live deployment, not this exact signed candidate. A disposable Windows VM/ISO and adequate disk/RAM were previously unavailable. Never relabel past successes as exact-SHA physical acceptance.

## Agent delivery refs observed remotely

| Owner | Proposed branch | Exact remote SHA at inspection |
|---|---|---|
| AI-01 SYSTEM Hub | agent/ai01-system-hub-boot | **Not observed** |
| AI-02 pre-login Agent | agent/ai02-prelogin-agent | `bbd4a97553c3fb985980d491bc1924353eab5349` |
| AI-03 CORE/Broker | agent/ai03-core-broker-repair | `43e8125e7a4ced654a769b661dc10938c02bc7a4` (same as integration; no independent new fix proven) |
| AI-04 SQLite | agent/ai04-sqlite-recovery | **Not observed** |
| AI-05 Network | agent/ai05-connection-recovery | **Not observed** |
| AI-06 QA | agent/ai06-release-qa | Record Git commit SHA and matching CI after QA push |

Source PRs #1086/#1087/#1088/#1089/#1090/#1092/#1094 are historical provenance, **not** new Agent delivery commits.

## Integration handoff and merge policy

1. Keep #1096 in **Draft / NO-GO**. Preserve source PRs. Do not auto-merge based on older CI.
2. Receive AI-01 SYSTEM Hub first and AI-02 pre-login second. Validate task identity, machine DPAPI, runtime ownership and login transition.
3. Receive AI-03 CORE/Broker P0 and demonstrate an effective privileged token, not just Task Scheduler Highest; handle legacy `0x800710E0` separately from actual execution denial.
4. Receive AI-04 persistence/rollback and AI-05 local-first reconnect/Cloudflare; reconcile any overlapping CLI/workflow sources using real candidate blob SHA and semantic review.
5. Apply AI-06 QA last. For each merged integration SHA, rerun 79/243 blob matrices, typecheck/build and matched hosted workflows. Never duplicate an active same-SHA workflow/input run.
6. Finally prove disposable Windows restart/power-loss, protected SQLite rollback, signed installer and two-PC privileged operation in a controlled test environment. GO requires explicit owner sign-off with physical receipts.

No live Work-PC Hub, Agent, Broker, SQLite, NAVEAX device, VM, auto-update or production source was changed by this AI-06 worktree.
