# K13 P007 — one non-core workflow for #1134 and #1149

Issue: #1006 (delegated CI test discovery), #539/R22 (false-positive CI evidence).

## Single review target

- Keep upstream Draft **#1149** as the integration candidate. This branch
  preserves **all seven unique files from #1134** plus its own four files;
  `.github/workflows/delegated-noncore.yml` now has one unified version.
- **#1134 remains open** until the coordinator/owner elects a disposition.
  Do not merge #1134 and #1149 independently: both add the exact same workflow
  path from different bases. Historical P005 reports remain evidence, not live
  acceptance of P007.
- The PR #1112 evidence tests are still preserved in the source PR. The
  `pr1112-auxiliary` job checks out its exact historical SHA and runs the
  regressions, but that *cannot* assert required CI for #1112.

## Preserved coverage in the consolidated workflow

1. Each Linux Node **22/24** seven-path job checks that checkout HEAD equals
   the workflow run SHA and runs P005 inventory and negative PR-coverage
   regressions alongside P006 TAP/CI-evidence gates (23 local assertions).
2. It inventories CI source via *both* P005 and P006 tools, then explicitly
   invokes all seven missing delegated test paths; a fail/skip/todo or zero
   selected tests cannot pass the auxiliary TAP gate.
3. Each Linux Node **22/24** historical #1112 job pins the known old source
   SHA and runs eleven historical K13 gate tests. It is AUXILIARY_ONLY.

## Proof and open decisions

- Upstream/fork `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`:
  55 delegated tests; 43 source-explicit, five single-directory npm glob
  candidates, seven with no known main CI callsite.
- #1149 **previous** exact SHA `5d5d186545b1c6e1e57f35eb35d2175890369087`
  has required upstream run **42485529477**, completed/success and seven
  successful jobs. Its required workflow **still does not invoke the seven
  delegated paths**, so seven-path required execution remains NOT_PROVEN.
- The same previous SHA has fork auxiliary run **42485485796**, two successful
  jobs; each explicitly ran the seven paths (33/33 assertions) and the P006
  gate tests (11/11). This does not prove an updated consolidation SHA.
- Before upload, locally: P005+P006 inventory/evidence suites **23/23 PASS**
  and historical #1112 suites **11/11 PASS**, Node 24. Seven delegated paths
  were not available in this older local checkout; no claim of local PASS for
  them. New consolidated HEAD **must be checked in its own CI run**.
- Protected owner `.github/workflows/ci.yml` remains untouched. Owner #1096
  must decide when to explicitly run these seven paths in required CI. The K20
  fixed `# tests 41`/`# pass 41` grep fails when tests grow even with zero
  TAP failures; replace brittle literal equality with validated nonzero
  dynamic TAP totals where the owner approves. Do not silently bypass failures.
- Physical Windows/two-machine/provider/release acceptance: **NOT_RUN**.
  Merge and issue close require explicit owner approval.
