# NEXOWIRE #24 — Date-partitioned exact SHA DAG acceptance (2026-10-22)

**DRAFT / SOURCE-ONLY / PRODUCTION P0 NO-GO.** Repository: `Naveax/Nexowire`. The prior #698 HEAD `b8606439a6a967185b72d599ee83ddc3ba00a36c` has verified exact-head CI **SUCCESS**, run `39645743195`. This review does not use it as permission for unrelated PRs.

## Recovered without rebuilding

The interrupted #24 branch was recovered, not replaced. The first 111 PRs retain their 14 staged exact-head CI + file/merge-base fixtures; the next 19 (#711–#729) and following 16 (#730–#746) preserve their independent GitHub receipts. #722, #726 and #727 were explicitly re-read after HEAD changes, and no old green CI was carried forward. New exact-head, changed-files and comparison records were obtained for #747–#760.

The latest four **disjoint date-partitioned search windows at capture** returned **14 / 89 / 41 / 16 = 160** unique open PRs, with no window at the 100-result search limit. These are snapshot numbers; any subsequent PR opening, closure, base update, CI run or HEAD change makes the stored result **STALE** until independently refreshed. The user's earlier 77/104/111 counts are not current evidence.

## Machine-readable inputs

- `docs/qa/fixtures/qa24-open-census-current-20261022.json`: exact 160 IDs and time-partition search criteria.
- `docs/qa/p0-open-dag-160-source-20261022.json`: 160 nodes, 132 parent dependency edges, SHA-bound CI and `base...head` merge-base, complete changed-file sets and 160-ID reconciliation.
- `docs/qa/fixtures/qa24-head-ci-part-01.json` through `part-14.json`, and `qa24-new-711-*.json` through `qa24-new-759-760.json`: source receipts retained for review.
- `scripts/qa24-partitioned-dag-review.ts`: deterministic read-only DAG validation, source owner conflict detection, fail-closed parent/CI/coverage assessment, conditional candidate ranking.
- `test/qa-24-partitioned-dag-review.test.ts`: fixed negatives, including synthetic stale next PR, duplicate/paginated source, fake green old SHA, no CI, red ancestor, owner collisions, wrong merge-base and cycles.

**Pinned census validation:** 160/160 unique PR IDs with all 160 changed-file listings and SHA comparisons recorded; 132 current-ref stack edges. **199 independent changed-file overlaps** were observed, excluding genuine ancestor-descendant stacks. 2 parent SHA mismatches: **#609/#622**. The stored primary CI histogram was **88 successful, 52 failed, 7 queued, 9 running, 4 unknown**. A specialized QA workflow never substitutes for primary CI, as independently seen on #717/#727.

CI **UNKNOWN** is not success. Notably #749, #753 and #757 did not have a verifiable exact-HEAD primary CI run when queried. Changes after snapshot creation are likewise **unverified**, even where a frozen entry says success.

## Conditional source-only review queue

Only two main-based independent docs/test/isolated-QA-workflow PRs passed the frozen rule set with no observed independent changed-file overlaps:

| Priority | PR | Observed exact SHA / CI | Decision |
|---|---|---|---|
| 1 | #657 | `561af65b6cc1659f413bf11918b4ff356738c960`, CI `39630539339` SUCCESS | **CONDITIONAL_SOURCE_REVIEW_ONLY** |
| 2 | #648 | `9d9d11b9326df49d4d1288b24c823f15367bf3eb`, CI `39628249630` SUCCESS | **CONDITIONAL_SOURCE_REVIEW_ONLY** |

**No merge is authorized.** Before #00 can consider either candidate, requery *all* open PR pages with uncapped partitions; compare exact current PR head and base SHA, all primary CI runs, full changed files, actual merge-base, branch protection and independent owner review. Source-only test success does not prove the real signed elevated Broker, effective protected Windows process token/ACL/FILETIME, external monotonic CAS/revoke, UAC enrollment or privileged Hyper-V capability.

## Reproduction

```sh
npm ci
node --test --import tsx test/qa-24-partitioned-dag-review.test.ts
node --import tsx scripts/qa24-partitioned-dag-review.ts > qa24-160-review.json
# Deliberate exit code 2: never production-approved.
```

For an authorized read-only live refresh use the existing `scripts/qa24-live-dag.ts` collector on the stacked parent, with a read-only `GH_TOKEN`. The static partition review intentionally cannot fake a fresh API recheck. If the fetched open set differs, reject the old candidate ranking and recompute; never silently trust an older snapshot.

## #00 integrator blockers

#609 and #622 are based on stale parent commits. Independent owner collisions in Windows Job `.github/workflows/ci.yml`, Native Job and process-manager trees require the #03/QA owners to reconcile. Green downstream #669/#670/#676/#712 are source-only and do not override red ancestors or absent physical trust authority. The #01 external reserve→dispatch/revoke barrier and #08 immutable final publication still require independent durable/physical evidence. Fail-close UNKNOWN and no replay. No Agent, signed Broker install, UAC, D1/DB, physical VM or ReVoltVPN-Ubuntu-Lab action occurred.

A GitHub DRAFT PR only transports test/docs evidence. Do not merge P0 into main on this report.
