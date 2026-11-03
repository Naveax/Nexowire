# CLEAN-02 | Unique security/QA evidence and partial-coverage blockers
Captured 2026-11-03 (Europe/Istanbul). Source HEAD of main: `42e6deb291d5720c66f31cc945d8c6519124615d`. This is a **read-only analysis**. NO merge, closure, branch deletion, CI dispatch or deployment is authorized by this document.

## Confirmed source/test artifacts not exactly present in main or coordinator #1067/#1068/#1070/#1071

| PR | Exact HEAD | Changed files | Exact HEAD checks | Decision |
|---|---|---|---|---|
| #599 | `0c24d2acf14b4d10f1f37a9f7072a30799665386` | 5 | 6 SUCCESS, browser-live FAILURE | STILL_UNIQUE, HOLD |
| #647 | `3b3f26d068f169b941383308a1763124e3a3feef` | 2 | 6 SUCCESS, browser-live FAILURE | STILL_UNIQUE, HOLD |
| #781 | `89a865363829c8c30a74de1516e53a697549c05b` | 1 | 7/7 SUCCESS | STILL_UNIQUE, preserve child #791 |
| #811 | `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 8 | 6 SUCCESS, browser-live FAILURE | STILL_UNIQUE, source + four preserved Git-negative tests; children #814/#821/#839/#845 |
| #813 | `9f5b6617884282ab135d453c2a75f9e7ad1d8437` | 2 | 6 SUCCESS, browser-live FAILURE | STILL_UNIQUE, protect child #836/#854 |
| #832 | `3010885c2a4dd4d8c66df574bfb758fe9170f220` | 2 | 5 SUCCESS, test (22) FAILURE, test (24) CANCELLED | STILL_UNIQUE, **intentional RED sandbox isolation** |

### #599: concrete missing behavior, not mere file-name difference

PR #599 adds `operationId` to the `idempotency` object in the error response of `src/mcp/create-server.ts`. Current main blob `7a47c9045a0411fa935c206c92486573f7ab47d2`, error path lines 621–632, includes `key`, `replayed`, `persistedStatus` / `outcomeUnconfirmed`, but **not `operationId` inside that object**. Do not drop the regression until equivalent error-contract behavior is implemented and tested. Its `test/qa-02-error-contract-no-replay.test.ts` and `test/qa-02-windows-output-ordering.test.ts` are absent from all checked coordinator trees.

### Source/test paths to retain

- #647: `test/p0-native-handle-provenance-w26.test.ts`, `docs/security/p0-native-handle-provenance-w26.md`.
- #781: `test/qa-18-durable-runbook-cloned-unknown-negative.test.ts`.
- #811: `src/agent/executors.ts`, `test/p20-780-git-fsmonitor-hook-escape-negative.test.ts`, `test/p26-780-git-worktree-root-escape-negative.test.ts`, `test/p26-811-nested-commitgraph-symlink-negative.test.ts`, `test/p37-780-adversarial-git-metadata-fuzz.test.ts`, `test/p37-780-git-packed-objects-escape-negative.test.ts`, `test/p50-780-git-clean-filter-external-command-negative.test.ts`, `test/p50-780-git-process-filter-external-command-negative.test.ts`.
- #813: `src/coding/reviewed-git-patch.ts`, `test/reviewed-git-patch.test.ts`.
- #832: `test/p46-780-cross-platform-task-sandbox-red.test.ts`, `docs/P1_780_P46_TASK_OS_SANDBOX_RED_QA_20261023.md`.

## CORE / Windows partially covered, NOT SUPERSEDED

| PR | Exact HEAD | Same Git blob at same path in coordinator #1067 | Risk |
|---|---|---|---|
| #576 Windows Job kernel/helper ownership | `f908bebfa202a5b01c41f7b168c7e87457aa0b21` | 17/25 | 8 nonmatching paths, including C guardian helper, build scripts, process cleanup and native trust tests. Has 19 descendants. |
| #582 Journal antirollback / #587 | `0e322c94c1e2ab0e58cf7b95115a03dee6bf1ccc` | 8/14 | 6 nonmatching paths, including `native-agent.ts`, `operation-journal.ts` and remote CAS. Has 41 descendants. |
| #608 Windows + MCP integration | `d34c0d3c85bc508be50c2e5f532aa964d8325106` | 16/24 | 8 nonmatching paths, stacked dependency. |
| #629 Windows + CORE QA | `19ac7fc42f482c4cd3c019f46ac7af1db05ec626` | 17/25 | 8 nonmatching paths, stacked dependency. |
| #616 Artifact bridge trust/fencing | `94b92e01219aca3cd4ca86775fe4b61a72ac53c4` | 10/21 | 11 changed paths not identical in current main or new #1070. |
| #634 Artifact writer fence | `9266f9b65a1f193360469223360552a50892949a` | 10/19 | 9 changed paths not identical in current main or new #1070. |

The same-path blob comparisons are **not** proof that different new code is semantically worse or better; review these exact changed hunks and negative tests before deciding.

## Scale S5 / #588 preserved chains, rechecked against new #1070

Coordinator #1070 latest exact HEAD `90775c701977d6ca5388a380950fb2f06c406cec` (changed since earlier `c2cb02ec...`). After rechecking its nontruncated tree:
- #615: **0/6** exact changed-file blobs match; child #628: **0/3**. Both have historical exact-head 7/7 SUCCESS, but are not thereby integrated.
- #610: **0/5** match; child #625: **0/3**. #610 historical exact-head 7/7 SUCCESS.
- #616 and #634 retain only the 10 partial matches above, shared with main.
- #596 large-stream and #598 MCP 9.5 MiB parser: **0/16** and **0/6** respectively. Their unique code and negative tests require independent review, not closure by #1070.

## Open issues are not PRs

- [#540](https://github.com/Naveax/Nexowire/issues/540): Windows ProcessManager descendant cleanup.
- [#587](https://github.com/Naveax/Nexowire/issues/587): rollback-external durable CAS proof.
- [#588](https://github.com/Naveax/Nexowire/issues/588): secure resumable large transfers.
- [#780](https://github.com/Naveax/Nexowire/issues/780): coding agent, reviewed Git diffs and true OS sandbox.
- [#1001](https://github.com/Naveax/Nexowire/issues/1001): Agent journal owner identity / PID reuse.

These issues remain OPEN; source CI or exact blob retention is not security/physical acceptance. **P0_UNSAFE for production deployment applies to the unresolved trust/OS sandbox flows**, not an assertion that the test-only PRs themselves must be deleted.

## Coordinator next actions (non-mutating until reviewed)

1. Freeze current exact SHA pairs; resolve all stacked children before any parent retarget/closure.
2. Review and port #599 operationId fix and the independent negative tests from #647/#781/#811/#813/#832 into an authorized integration tree; retain failing expectations, do not skip.
3. Compare the 8+6 unmatched #576/#582 Windows/Journal blobs and actual patch hunks against #1067, plus exact #1001/#540/#587 regressions; no physical CORE install.
4. Compare #610/#615/#628 and #596/#598/#616/#634 against current Scale coordinator #1070, preserving quota/cancel/UNKNOWN/fairness semantics.
5. Run `git merge-base`, `git cherry`, `git patch-id --stable` in a trusted clean checkout, plus target commit CI and owner reviews. These commands were not runnable in this tool session: local git remote DNS blocked.
6. Only after actual target landing + child migration + negative test acceptance should a coordinator propose **per-PR** closure with exact landing commit and durable evidence.

**Closure-approved SUPERSEDED list: EMPTY.** The separate `CLEAN02_SUPERSEDED_EVIDENCE_20261103.md` contains eight fully blob-covered candidates but all remain HOLD.
