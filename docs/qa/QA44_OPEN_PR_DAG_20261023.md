# NEXOWIRE #44: Independent open-PR DAG and exact-head CI QA

Owner #44. Coordinator #539, product #780. Complements QA24 PR #810 without changing its branch.

## Read-only run

`GH_TOKEN=<read-only token> node --import tsx scripts/qa44-open-pr-integration.ts Naveax/Nexowire 708,718,726,776,786,791,795,797,800,802,803,804,805,806,807,808,810,811`

GET-only GitHub REST. No dispatch, rerun, merge, Agent, Broker, UAC, VM, live D1, production or workflow modification. The script intentionally returns exit 2 for a completed NO_GO evidence report, or exit 3 for a failed collection (also NO_GO). Keep tokens out of reports and checkpoints.

## Collector contract

- Fully enumerate every open PR with REST per_page=100 and double-read sorted exact number/head SHA/ref/base SHA/ref, plus main SHA. Reject duplicate IDs, missing pages, changed census, moved selected PR and changed main; the two passes are not an atomic server snapshot.
- Select critical PRs explicitly by CLI and/or P0/P1 labels, then include open parent branches transitively. Missing or unlabeled critical ownership still requires #00 manual scoping.
- Pin each critical PR's metadata, page through changed filenames, include renamed preimages, verify merge-base, and fetch matching exact-head pull_request Actions runs. List endpoint lacks changed_files; individual PR GET supplies its expected file count. More than 3000 files fails closed.
- Record workflow ID, run ID, attempt, status, conclusion and queried HEAD. Flag missing/failing/unfinished exact CI, concurrent same-workflow active runs, and reruns in progress; re-read Actions after second census and flag drift. Never start or rerun CI.
- Flag stale parent SHA, ambiguous/missing parent branch, stale main base, divergent merge-base, red/unknown ancestors and same-file overlaps between independent critical branches. Parent/descendant file overlap is not mislabeled cross-owner collision. Different branches are a conservative proxy for owner independence, not a human identity proof.
- Enumerating all PR refs does not imply complete changed-file/CI evidence for unselected PRs; such incomplete graph coverage cannot grant merge.

## Non-authorization

Output fields are invariant: gate=NO_GO, production_merge_authorized=false, safe_merge_queue=[]. Successful source tests do not grant merge, native permissions, physical Windows acceptance or deployed external CAS. #00 must manually prove all prerequisites and approve any future queue. All PRs remain DRAFT/review-only under this #44 work.

## Test witness

`node --test --import tsx test/qa-44-open-pr-integration.test.ts`

Seven local deterministic cases passed with a 205-open-PR mock: two-pass pagination, torn count/HEAD, incomplete changed-file pages, stale SHA, red ancestor, independent-file collisions, concurrent workflow and rerun, Actions drift, divergent base and empty merge queue. Mock fixture results are source-only, not live integration proof.

## Point-in-time live observations

2026-10-23: GitHub connector GET returned 220 OPEN (100+100+20), main 754cc4364822be5fda528f54042fb22a84f19924. Earlier 210 OPEN were observed in this same session. GitHub PR #810 at HEAD 0ef7e6290bbb5bb64d4b6a01839ff33c252eb7f7 has Actions run 39843615134 SUCCESS. Ongoing independent PR creation changes census immediately. Nothing here authorizes a merge.
