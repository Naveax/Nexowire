# Nexowire PR DAG audit, 7 November 2026

## Scope
Read-only, exact-HEAD audit of all **353 open pull requests** in `Naveax/Nexowire`. No pull request, branch or source commit was deleted by this audit. The file `NEXOWIRE_PR_DAG_AUDIT_20261107.csv` contains one full-provenance row per open pull request.

| Metric | Result |
|---|---:|
| Open PRs enumerated | 353 |
| Exact PR HEAD refs downloaded and checked | 353 |
| Distinct PR HEAD SHA values | 353 |
| Open PR HEADs already ancestors of main | 0 |
| Open PR HEADs with identical tree to main | 0 |
| Open PRs covered by another open PR history | 215 |
| Frontier candidates (no observed open descendant PR) | 138 |
| Open PRs whose HEADs are already ancestors of #1096 | 15 |
| PRs eligible for deletion under the strict *already merged into main* policy | **0** |

**Main at snapshot**: `8b4f1709ee221f4a4b86b07ff1250578d3edba4d`
**Unified candidate #1096 HEAD**: `61f3b66492cc4f04cc8acf8f21a578ad74ef07e9`
**Locally observed commit objects**: 2061
**Repository shallow**: `true`

## Preserved in unified integration #1096
The exact HEAD commit of each of the following open PRs is an ancestor of #1096 (including #1096 itself):

#1096, #1094, #1093, #1092, #1091, #1089, #1088, #1087, #1086, #1085, #1083, #1075, #1074, #1044, #1003

This confirms Git DAG preservation at the audited commit identities. It does **not** confirm that each feature has passed runtime acceptance or that #1096 is deployable.

## Remaining independent integration candidates
Locally observed frontier count: **138**. Example recent frontier PRs:

#1096, #1090, #1082, #1080, #1078, #1077, #1068, #1067, #1035, #1030, #1016, #1015, #1011, #1010, #1005, #1004, #993, #992, #991, #990, #989, #988, #987, #985, #941, #931, #928, #927, #915, #913, #908, #907, #858, #857, #855

**Important**: the local Git repository is shallow. Positive ancestry results are valid; a missing ancestry link or a frontier classification can be a false negative beyond the shallow boundary. A complete unshallowed merge-base verification is required before destructive cleanup.

## Safe cleanup rule
1. First complete the independent Windows disposable-VM acceptance, then merge the exact CI-passing #1096 (or reconcile with the new main HEAD and retest).
2. Refresh all PR HEADs and main, and confirm each closure candidate's exact source HEAD is an ancestor of main.
3. Close only verified superseded PRs with a source SHA and successor merge reference in the closure comment.
4. Do not automatically delete remote source branches with unique commits. Verify no other open PR uses them as a base.
5. Recheck running CI before branch modifications; do not re-trigger the same workflow on the same SHA.
6. Report unexpected ancestry, unmerged source blobs and orphaned work as actionable blockers rather than silently discarding them.

This is a **source-preservation inventory**, not a blanket permission to close 215 PRs.
