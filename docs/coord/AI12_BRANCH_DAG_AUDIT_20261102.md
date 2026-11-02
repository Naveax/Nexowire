# AI-12 | Nexowire branch/PR DAG, exact-HEAD evidence and cautious triage

> **Read-only decision report.** Baseline captured 2026-11-01 ~21:49 UTC / 2026-11-02 ~00:49 Europe/Istanbul. Repository: [Naveax/Nexowire](https://github.com/Naveax/Nexowire). **Never treat this as a merge/delete/CORE authorization.**

## 1. Fresh state and reconciliation

- Canonical main HEAD at check: `29205069924259af78b7075216fd5132248de9fb` ([commit](https://github.com/Naveax/Nexowire/commit/29205069924259af78b7075216fd5132248de9fb)). Contains source merge #1043 Windows Job helper fallback; not physical Windows or CORE acceptance.
- Live branch-name API pagination: **394** distinct branches, five 100-item pages (last partial). The latest new branch `ai/11-connection-v2-negative-20261102` belongs to Draft [#1044](https://github.com/Naveax/Nexowire/pull/1044).
- Live open-PR search was split into creation-date buckets, with **both ascending and descending searches** for the >100-result 2026-10-21 bucket. Unique open PR IDs: **368**.
- The old [OPEN_PRS_2026-11-01.csv](../inventory/OPEN_PRS_2026-11-01.csv) contains **368 historical open PRs**; compared to live, **#480 is now CLOSED/unmerged** and **new #1044 is OPEN/Draft**. The [branch snapshot](../inventory/BRANCHES_2026-11-01.csv) contained 397 names, so do not carry over its count. Historical snapshot classified 87 direct-main and 281 stacked, but base targets for *all* live 368 were not independently refreshed in this report.
- Frozen 48h protection reference: `2026-10-30T21:44:00Z`. Any last-48h branch/PR, active owner branch, or in-flight/unknown CI is protected. Recompute on any future action.

## 2. Categories / demonstrated examples

| Category | Demonstrated evidence | Handling |
|---|---|---|
| Already in main | `ai/01-wal-v108`: `main...branch` = **ahead 0 / behind 31**, merge base `b5ff33a77af931edcd6c64ef41ca2114eeb2a037` | Ancestor verified for this *single* branch only. Recent/protected policy still applies. |
| Patch-equivalent | Previously closed [#480](https://github.com/Naveax/Nexowire/pull/480) now confirms `closed/merged=false`; its patch equivalence was concluded in earlier cleanup records, **not re-proven here** | Audit log only; do not interpret this as evidence for other PRs. |
| Stacked parent/child | [#615](https://github.com/Naveax/Nexowire/pull/615) → [#628](https://github.com/Naveax/Nexowire/pull/628); #610 → #625; #781 → #791. Child bases checked through live PR metadata | Parent cannot be retired/rebased without downstream plan. |
| Independent main-target | #861, #831: open Draft, base `main`, no child in historical full PR snapshot, independent changed paths | Review source for novelty; do not auto-merge. |
| Fork HEAD / approval-required | [#997](https://github.com/Naveax/Nexowire/pull/997), [#998](https://github.com/Naveax/Nexowire/pull/998), [#999](https://github.com/Naveax/Nexowire/pull/999), [#1000](https://github.com/Naveax/Nexowire/pull/1000): HEAD repo `SinsiVinci/Nexowire-fork`; exact SHA PR-triggered runs ended `action_required` | External fork source lineage/patched HEAD must be inspected; `action_required` is never PASS. No dispatch. |
| Active 48h / AI ownership | #1044 is new Draft; protect 8 CORE agents and #987/#988/#989/#992/#995; recent integration and CI cannot be cleaned | Hands off, no merges or closures. |
| CI RED | #823/#832/#800/#599/#647 exact-head PR CI conclusion `failure` | Do not discard regressions merely to reduce PR count. |

**Important distinction:** GitHub compare `ahead_by>0` proves commit divergence, **not** semantic uniqueness or patch-id inequality. On selected candidates, an absent path on main or differing Git blob was additionally checked; there was no disposable local full Git checkout for `git cherry -v`, patch-id comparison, merge remerge diff, or complete 394-branch SHA/DAG audit. Therefore **none** of these sampled divergent PRs is certified patch-equivalent or safe-to-close.

## 3. Five non-CORE integration *review* candidates with successful historical exact-head CI

All five were updated before the protected cutoff; exact PR head/base and paths were checked live. Historical CI results cover **their listed old SHA only**. All five CI runs were `completed/success` with seven latest-attempt jobs `completed/success`; run attempt numbers were not exposed by this connector. The repo's main moved substantially since those runs.

| PR | Branch | Exact head SHA | PR-reported base SHA | Ahead/behind vs current main | Changed paths | Patch evidence | Child PR | CI exact HEAD | Safe next action |
|---|---|---|---|---:|---|---|---|---|---|
| [#861](https://github.com/Naveax/Nexowire/pull/861) | `qa/11-system-ci-r01-r22-20261024` | `07f8a2ecbe9e2285895cf55042bb9b6aaebf8861` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 1/119 | `docs/qa/QA11_EXACT_HEAD_CI_R01_R22_20261024.md` | Path absent on main; new content, patch-id unverified | None identified | [40042822372](https://github.com/Naveax/Nexowire/actions/runs/40042822372) SUCCESS (7/7) | Review archival value / adapt to current R01-R22 and rerun CI against updated base |
| [#831](https://github.com/Naveax/Nexowire/pull/831) | `test/44-open-pr-dag-exact-ci-20261023` | `f305cc910d5b1c55b99de024216b2e6a1114fc68` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 9/119 | `docs/qa/QA44_OPEN_PR_DAG_20261023.md`; `scripts/qa44-open-pr-integration.ts`; `test/qa-44-open-pr-integration.test.ts` | Script absent on main; new content, patch-id unverified | None identified | [39869258466](https://github.com/Naveax/Nexowire/actions/runs/39869258466) SUCCESS (7/7) | Inspect overlap with new coordinator scripts; isolate unique test logic before integration |
| [#615](https://github.com/Naveax/Nexowire/pull/615) | `test/parallel-15-s5-oct21-gzip-proof` | `a1c65587730a1eaf331337b9b3422aa93541ee30` | `4c5c810134c020cd04a5ef2be5c1138ea1954ad0` (`main`) | 4/122 | 6: docs, benchmark/report scripts, S5 test, JSON evidence | `scripts/bench-s5-http-mcp-isolation.ts` differs in blob SHA from main; patch-id unverified | #628 (verified open) | [39598738701](https://github.com/Naveax/Nexowire/actions/runs/39598738701) SUCCESS (7/7) | Preserve #628 parent; review changed benchmark and reproducibility, retest new base |
| [#610](https://github.com/Naveax/Nexowire/pull/610) | `test/parallel-14-quota-receipt-provenance-20261021` | `3064acdf18b0817ecf3650ec7d61f9233d36a009` | `4c5c810134c020cd04a5ef2be5c1138ea1954ad0` (`main`) | 1/122 | 5: `src/ops/scale-v2-artifact-byte-budget-staging.ts`, 3 tests, 1 doc | Source file blob differs from main; patch-id unverified | #625 (verified open) | [39597505104](https://github.com/Naveax/Nexowire/actions/runs/39597505104) SUCCESS (7/7) | Preserve #625 parent; inspect receipt acceptance and overlap with main before rebase |
| [#781](https://github.com/Naveax/Nexowire/pull/781) | `qa/18-runbook-clone-unknown-replay-20261022` | `89a865363829c8c30a74de1516e53a697549c05b` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 1/119 | `test/qa-18-durable-runbook-cloned-unknown-negative.test.ts` | Test path absent on main; new content, patch-id unverified | #791 (verified open) | [39816363122](https://github.com/Naveax/Nexowire/actions/runs/39816363122) SUCCESS (7/7) | Preserve #791 parent; keep negative replay invariant and port test only after ownership review |

## 4. Five *conditional closure-review* candidates (NOT closure-approved)

These were deliberately picked among old Drafts with **no identified child** in the 2026-11-01 full PR graph and exact-head CI RED. Their changed paths/tests are not shown to be patch-equivalent to main. A RED run or stale date **never** authorizes closure. Status for every row is **HOLD, review for supersession**.

| PR | Branch | Exact head SHA | PR-reported base SHA | Ahead/behind vs current main | Changed paths | Patch evidence | Child PR | CI exact HEAD | Safe next action |
|---|---|---|---|---:|---|---|---|---|---|
| [#823](https://github.com/Naveax/Nexowire/pull/823) | `docs/qa49-release-acceptance-r01-r22-20261023` | `133956fe4285057b35cc94854835a51510765074` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 2/119 | `docs/NEXOWIRE_49_RELEASE_ACCEPTANCE_R01_R22_P1_20261023.md` | Path absent on main; NOT patch-equivalent | None identified | [39869161871](https://github.com/Naveax/Nexowire/actions/runs/39869161871) FAILURE | Check whether findings transferred to `docs/PROJECT_STATUS.md`; only then propose close with explicit citation |
| [#832](https://github.com/Naveax/Nexowire/pull/832) | `qa/p46-780-task-sandbox-cross-platform-red-20261023` | `3010885c2a4dd4d8c66df574bfb758fe9170f220` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 2/119 | `docs/P1_780_P46_TASK_OS_SANDBOX_RED_QA_20261023.md`; `test/p46-780-cross-platform-task-sandbox-red.test.ts` | Test absent on main; NOT patch-equivalent | None identified | [39863614267](https://github.com/Naveax/Nexowire/actions/runs/39863614267) FAILURE | Do not discard RED security evidence; closure only after equivalent negative coverage is integrated |
| [#800](https://github.com/Naveax/Nexowire/pull/800) | `test/20-780-git-fsmonitor-hook-escape-20261022` | `6eb562cffd68a5d123e8ec2455fd2d3d8d9a9fd8` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 1/119 | `test/p20-780-git-fsmonitor-hook-escape-negative.test.ts` | Test absent on main; NOT patch-equivalent | None identified | [39823730640](https://github.com/Naveax/Nexowire/actions/runs/39823730640) FAILURE | Verify Git fsmonitor mitigation and matching coverage in main; else retain open |
| [#599](https://github.com/Naveax/Nexowire/pull/599) | `test/02-error-ordering-negative-20261020` | `0c24d2acf14b4d10f1f37a9f7072a30799665386` | `fda2a2da164ea7c6a2fe2271fc669f1fd623cede` (`main`) | 1/126 | 5: `.github/workflows/ci.yml`, `src/mcp/create-server.ts`, 2 tests, 1 doc | Negative-test path absent on main; NOT patch-equivalent | None identified | [39492086789](https://github.com/Naveax/Nexowire/actions/runs/39492086789) FAILURE | Review workflow/runtime ownership and no-replay behavior; do not close without replacement evidence |
| [#647](https://github.com/Naveax/Nexowire/pull/647) | `qa/w26-native-handle-provenance-20261021` | `3b3f26d068f169b941383308a1763124e3a3feef` | `754cc4364822be5fda528f54042fb22a84f19924` (`main`) | 2/119 | `docs/security/p0-native-handle-provenance-w26.md`; `test/p0-native-handle-provenance-w26.test.ts` | Test path absent on main; NOT patch-equivalent | None identified | [39627227248](https://github.com/Naveax/Nexowire/actions/runs/39627227248) FAILURE | Require Windows handle provenance replacement test/source evidence before considering close |

## 5. Recommended ordering for coordinator

1. **Do not touch** all last-48h branches, 8 CORE agents, #987/#988/#989/#992/#995, fork/action_required PRs and nonterminal CI.
2. Review #861 then #831 as independent documentation/QA improvements; compare to today's coordinator scripts and canonical status. Small visible patches, no known child.
3. Review #781 → #791, #610 → #625 and #615 → #628 as **three parent/child chains**. Preserve child base; no squash/rebase/merge until exact fresh bases and semantic tests are checked.
4. For #823, #832, #800, #599, #647, first establish replacement evidence and owner signoff. Until then keep open; no silent closure.
5. Before any future mutating cleanup: fresh all-pages PR/branch snapshots, exact SHA and commit dates, `git merge-base --is-ancestor`, `git cherry -v`, full patch-id comparison, `git show --remerge-diff` where relevant; separate fork heads; check all matching run IDs, attempts and job conclusions. Never mistake `skipped`, `queued`, `in_progress`, `action_required`, `unknown` for PASS.

## 6. Data provenance and restrictions

Read-only GitHub connector calls: branch pagination, date-partitioned open-PR searches, `get_pr_info`, `compare_commits`, changed filenames, per-ref `fetch_file` SHA/existence, commit workflow runs and run jobs. Snapshot files are only historical comparators. No local `git status` or `git fetch --prune` was performed because this session had no cloned repository and external git fetch was DNS-blocked. Full DAG/patch-id certainty is **not** claimed. The documentation branch/PR contains no runtime source change. **No existing PR/issue closure, branch deletion, merge, CI dispatch, deploy, UAC, device restart or CORE state change.**

**Safety disposition:** Source integration remains review-only; signed Windows and production CORE acceptance remain **NO-GO**.

## 7. Second live pass: complete ref/PR identity inventory and orphan ancestry

This section supersedes the **earlier count** but does not retroactively change its historical capture. GitHub REST GET `git/refs/heads` and four paginated `pulls?state=open&per_page=100&page=N` lists captured **397 origin branch ref/SHA pairs** and **371 open PR exact head/base SHA pairs** (370 Draft / 1 ready). All **335 origin-hosted** open PR head SHA values matched their current origin branch ref SHA. **36 PR heads are from SinsiVinci/Nexowire-fork**, requiring explicit fork handling; origin branch enumeration cannot substitute for their head identities.

- **89 direct-main PRs**; **282 stacked PRs**; **279 stacked links lead to another open origin PR**. The remaining three target an existing origin branch without an open parent PR:
  - [#920](https://github.com/Naveax/Nexowire/pull/920) bases on `qa/11-core-ci-source-evidence-boundary-20261027`, tip `b1bb45f74d298ce10610f59412be17f77df9bcb6`; former [#912](https://github.com/Naveax/Nexowire/pull/912) is **merged**. Base ref is still required.
  - [#776](https://github.com/Naveax/Nexowire/pull/776) bases on `test/21-isolated-integration-768-770-20261022`, tip `3247ed65133a548730c77330b795a5a1e05d28f3`; no parent PR found in the branch-head search. Retain branch and evidence.
  - [#715](https://github.com/Naveax/Nexowire/pull/715) bases on `feat/parallel-10-broker-preflight-20261021`, **PR-reported base SHA** `54d5451d38aa3bb008640f9913bdabbd44980138`, **current ref tip** `6c85683014156b32f7daf4da6a768d23ab72a203`; former [#665](https://github.com/Naveax/Nexowire/pull/665) is **merged**. This is a **stale PR base snapshot**, not permission to delete the branch.
- **58 origin branches** have neither an open PR head nor open PR base edge (excluding `main`). All 58 were compared by immutable tip SHA with `main@29205069924259af78b7075216fd5132248de9fb`: **5 are actual commit ancestors (ahead=0)** and **53 are diverged (ahead>0)**. Divergence does not prove patch uniqueness; patch-id is still `NOT_PROVEN`.
- The five *commit-ancestor* branch tips are:
  - `ai/01-wal-v108` `b5ff33a77af931edcd6c64ef41ca2114eeb2a037`, 0 ahead / 31 behind, 2026-10-31T22:44:07Z, **48h protected**.
  - `coord/v108-exact-head-integration-gates-20261031` `7a36fdcf7cce208c87889e830f2e470a84a701a0`, 0/25, 2026-10-31T13:14:15Z, **48h protected**.
  - `feat/solkaun-unmetered-hosted-tool-credits-20261030` `0818411b9d07bf9efbc75ba94fe28d1e94ac1ccc`, 0/70, 2026-10-29T21:55:30Z, older than the frozen 48h cutoff, but **active-CI/owner final check still missing, so no deletion proposed**.
  - `fix/agent-journal-startup-preflight-serialize-20261101` `8a9e7c814529b462c5d3b93728202a5ca0561c8d`, 0/3, 2026-10-31T23:29:58Z, **48h protected**.
  - `fix/journal-owner-restart-20261031` `bce2dbdfca93d3537657c37e15d9248f17106a8a`, 0/35, 2026-10-31T20:56:54Z, **48h protected**.

**Full reproducibility artifacts on this Draft only:** [open PR exact-SHA DAG](AI12_OPEN_PRS_DAG_20261102.csv), [397 branch ref/role/ancestry inventory](AI12_BRANCH_REFS_20261102.csv), and [58 independently compared orphan branches](AI12_UNLINKED_BRANCH_COMPARE_20261102.csv). Fields not independently fetched are explicitly `NOT_CHECKED` / `NOT_PROVEN`; no unverifiable PASS or patch-equivalence labels.

## 8. Source-level triage correction

The old conditional closure-review row for [#599](https://github.com/Naveax/Nexowire/pull/599) is **superseded**: in `src/mcp/create-server.ts`, its diff adds `operationId` specifically inside the error-path idempotency response; the `main@29205069924259af78b7075216fd5132248de9fb` version lacks that field in the corresponding response. **Remove #599 from any closure shortlist, keep the RED regression and route to Error Contract owner for a scoped fix.** This is a source distinction, not proof the entire PR is merge-ready.

For [#610](https://github.com/Naveax/Nexowire/pull/610), main has `TrustedDurableChunkReceipt` and `verifyWriterFence`, but lacks the historical `ArtifactDurableProofVerifier` interface. Treat as **semantic-compatibility check**, neither automatically duplicate nor safe to cherry-pick. For [#615](https://github.com/Naveax/Nexowire/pull/615), `probeGzipUnderLoad` / `gzipSync` were present on the PR HEAD but absent in the corresponding main benchmark; retain the parent/child chain.

**No actual closure is supported by this review.** The five originally listed rows were *review targets*, not five proven safe closures; after #599's correction there are only four unresolved stale-RED closure-review rows, all HOLD. Do not make up a fifth to satisfy a quota.

**Automation boundary:** no workflow dispatch/retry, merge, deletion, issue closure or deploy. This CSV/doc revision uses the existing Draft documentation branch only. Old and new CI runs remain SHA-specific and must not be treated as the same run.
