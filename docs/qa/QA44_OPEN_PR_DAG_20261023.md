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

Eight local deterministic cases passed with a 205-open-PR mock: two-pass pagination, torn count/HEAD, incomplete changed-file pages, stale SHA, red ancestor, independent-file collisions, concurrent workflow and rerun, Actions drift, divergent base and empty merge queue. Mock fixture results are source-only, not live integration proof.

## Point-in-time live observations

2026-10-23: GitHub connector GET returned 220 OPEN (100+100+20), main 754cc4364822be5fda528f54042fb22a84f19924. Earlier 210 OPEN were observed in this same session. GitHub PR #810 at HEAD 0ef7e6290bbb5bb64d4b6a01839ff33c252eb7f7 has Actions run 39843615134 SUCCESS. Ongoing independent PR creation changes census immediately. Nothing here authorizes a merge.

## NEXT2 2026-10-23: full live list vs historical #24/#16

Connected GitHub REST, two full sequential GET passes over open PRs:
- Pass A: 244 open, pages [100,100,44]; pass B: identical 244 PR number/HEAD/base/ref set, pages [100,100,44]. Newest PR #846, oldest #480. Main pinned `754cc4364822be5fda528f54042fb22a84f19924`.
- This is a point-in-time double-read **of refs**. GitHub does not supply atomic cross-resource snapshots. Later #718 head moved again, demonstrating how quickly previously pinned evidence goes stale. Re-query before any claim; failed live collection is NO_GO.
- #24 PR #810 HEAD `0ef7e6290bbb5bb64d4b6a01839ff33c252eb7f7` run `39843615134` SUCCESS but its 202-node detailed static DAG and 205-open historical fixture are stale. It did not audit all current 244 details. Do not overwrite #24 fixtures.
- QA16 #846 HEAD `9f24221907ec204e95ceb156f7d3fd74f684e9b8` is stacked on #837 `1d2a455803407b077d6838b51a3a4b0d685150e8`; .github/workflows/ci.yml overlaps independent #801/#802 and other QA16 workflows. #846 latest run `39868040662` observed IN_PROGRESS with Node24 and intentional negative acceptance RED, not cleared.
- #718 HEAD changed to `d0a9ba925580c44c5f2f48a709fb0b7e968430c1`, run `39866600323` FAILURE; #817 base `20ef28fa725f21e9585b73263feef72705c1dedf` and #806 base `3bb5c880e564336fe829d450ce1df7e310935fc5` are stale. Both child runs failed. Do not certify their negative tests as owner source release.
- #811 HEAD `600a0286557d360681be7bd7b86da95ba57f1980`, `39854971347` SUCCESS, but separate red test-only descendants #814 HEAD `daec5dbd6da1a9e1b703afdee660548ccb96367a` run `39865936576` FAILURE, #821 HEAD `ef87410cc7921540dabf33b83e42824cce4f4668` run `39862537837` FAILURE and #839 HEAD `4eab61585f3f4174f4477a5ee671a0cee2a46398` run `39866019102` FAILURE. Git link/object, clean/process filter source red remain distinct. Keep tests unchanged.
- #807 HEAD `1e84d87c98c91b2d6e97a47de610ffe353d199df`, run `39841880930` FAILURE and inherits #797 green over #785 green over #777 red. Descendants #816/#824/#834 based on #807 do not repair parent. Own HEAD GREEN never lifts a RED ancestor.
- #826 HEAD `5e307dd48657512ed0e5d5b2908e7d2cd93ec6b5`, run `39866105972` FAILURE. Node22 had four legacy positive failures (private headless override, nested private graph, durable graph persisted dependency steps, retry_unknown admission). This is genuine fail-closed availability/compatibility regression. Never weaken originals or claim external CAS. Node24 CANCELLED, Windows browser-live SUCCESS.
- #831 prior exact HEAD `d81fe9019121f83753d65fa80fe3beea67b0a4e9` run `39863973746` **7/7 SUCCESS**, source only.

**NEXT2 source change:** critical selected roots now transitively include all open, unlabeled, test-only descendant PR branches, even where child base SHA is stale, and include upstream ancestor chains. Two additional isolated QA44 regressions assert stale-parent and red-parent propagation. This closes a missing DAG scope relative to #24 static selected nodes, not the missing external protected production authority.

Safe merge queue `[]`. Always NO_GO. No branch merges, workflow modifications or manual same-SHA CI reruns; #00 remains sole manual gate.
