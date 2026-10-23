# QA24 NEXT4: independent live PR DAG delta (2026-10-23)

Scope: `Naveax/Nexowire` read-only evidence collection, **QA24 documentation only**. No production source, main merge, native Agent/Broker, D1, UAC, ACL, VM or GitHub Actions rerun.

## Collection method and exact current snapshot

Authenticated GitHub REST `GET /repos/Naveax/Nexowire/pulls?state=open&per_page=100&page=1..4` was independently traversed **twice** with page sizes **100 / 100 / 48 / 0** both times. Each pass contained **248 distinct OPEN PRs**, latest **#852**, with **identical** PR numbers, `head.sha`, `base.sha`, `head.ref`, and `base.ref` across passes. Date-partitioned GitHub search independently corroborated the 248 count, and `GET /repos/Naveax/Nexowire/commits/main` returned `754cc4364822be5fda528f54042fb22a84f19924`.

**Change against the earlier QA24 248-ref fixture** `qa24-open-rest-two-pass-20261023.json`: **#849 CLOSED** and **#852 OPEN**. The numerical 248 total did not change, but the membership did. Preserve the earlier fixture as a historical immutable capture, NOT a current complete list.

Recomputed current DAG: **202 parent edges**, **14 mismatched child `base.sha` vs live parent `head.sha`**; only **#776** references a parent branch absent from the OPEN PR head set. The previous snapshot's 201 edges / 13 stale / #776 + #849 unresolved no longer describes the current open set. A `main`-targeting PR's `base.sha` is not permission to merge; 17 of the 45 such entries differed from independently fetched current main and need individual compare/branch-protection verification.

### All 14 live stale-parent edges

`#609 ← #576`, `#622 ← #618`, `#794 ← #783`, `#806 ← #718`, `#814 ← #811`, `#817 ← #718`, `#821 ← #811`, `#835 ← #718`, `#836 ← #813`, **`#837 ← #809`**, `#839 ← #811`, `#840 ← #826`, `#843 ← #826`, `#845 ← #811`.

A passed run on a stale QA/test-only parent does **not** prove the current parent; this is a comparison between live GitHub ref SHAs, not a branch-name guess.

## SHA-bound critical CI, independently fetched

| PR | Exact head SHA | Workflow run | Observed conclusion |
|---|---|---|---|
| #810 | `0ef7e6290bbb5bb64d4b6a01839ff33c252eb7f7` | 39843615134 | SUCCESS, inherited QA24 source-only |
| #811 | `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 39939395440 | **FAILURE**: Windows browser-live / fast-exit output ordering. Earlier `f7a8fae` / 39913730567 SUCCESS is historical |
| #826 | `ba21955cedc7be43fe57c5b2fe4c8e2c4c656966` | 39938851608 | **FAILURE**: Node24 **18 FAIL / 1818 PASS / 273 SKIP**, plus Windows browser-live; fail-closed external native task-graph admission also rejects old positive paths. Earlier `aabc75fd` / 39914532851 is historical |
| #845 | `6b16de921ce059f28f5e2e9254ff9de764457bef` | 39868037273 | **FAILURE**: commit-graph symlink QA built on **historical #811 `600a028...`** |
| #829 | `5715402142968498ce6d53014888e1c39f6e2ac9` | 39863445519 and 39863445634 | **SUCCESS**: NWJOB5 source/QA, not physical installed HIGH Broker |
| #847 | `79fdecf348b526c1e876f434d6f0292769b2bc17` | 39914505805 | **FAILURE**: original direct task-graph UNKNOWN attack against historical source |
| #852 | `1efe8b28d458cc4cb12df1b4cfe29f40b2eef034` | 39941374716 | **FAILURE**: 6/7 jobs successful; Windows browser-live structured registry/tasks/event-log/firewall test failed |
| #831 | `f305cc910d5b1c55b99de024216b2e6a1114fc68` | 39869258466 | SUCCESS, REST QA collector source only |
| #837 | `1d2a455803407b077d6838b51a3a4b0d685150e8` | 39864371572 | FAILURE; now also **stale #809 parent** |
| #850 | `70d67c8e1824c63baf95830f31e21fb8bc5230b2` | 39939244397 | SUCCESS, independent QA17 physical contract only, not attested installed Broker |
| #851 | `2b60d105a3fab15170908046797966d995dff5bb` | 39939385622, 39939385483 | SUCCESS, source-level strict JSON seam only |
| #708 | `36b443ef300d6465fa11af3a02c94b394d8841a1` | 39824007092 | FAILURE, comparison DIVERGED |
| #726 | `50491525249bcc1f5c47b90f23890b2b3062e33d` | 39823764746 | FAILURE |
| #801 | `6742ddfceb3456846f4cbebef10eb8e262e4eec1` | 39823885977 | SUCCESS, source-only |
| #802 | `12c7511bdeb9e1f015a9eea67a4dd631c6d312fe` | 39824624827 | FAILURE |
| #809 | `f5a2897928ea30f322dc7f4049f8728dc2fa900c` | 39944387608 | IN_PROGRESS at observation; do not rerun unchanged SHA |

## Parent drift, true owner collisions, evidence limits

- **#811 vs #826** independently modify `src/agent/executors.ts`. Direct compare of their current heads returned **DIVERGED**, so neither can silently inherit the other's source authority.
- **#801 vs #802** and **#801 vs #837** overlap `.github/workflows/ci.yml`, which is owner-scoped conflict evidence, not resolved by #801's green result.
- **#845/#814/#821/#839** sit on **stale #811 parent SHA `600a028...`**. #845's 39868037273 RED is not proof of current `daa166e...` behavior. The current-#811 versus #845 compare returned **DIVERGED**, merge-base `600a028...`. Preserve the original hostile negatives and require unchanged cross-run evidence, including healthy Windows Git positive.
- **#840/#843** sit on stale #826; #847 must be interpreted against its tested historical base, not extrapolated to newest #826.
- **#849 CLOSED**, so its previous test-file overlap with #847 is historical, not an OPEN/OPEN collision.
- This is full two-pass **HEAD/base/ref DAG evidence**, **not** full all-248 current CI/changed-path/merge-base coverage. Critical paths and current CI were fetched for a narrower owner/QA set only. Never infer a global collision-free safe candidate from that subset.

## Operational disposition

**#00 SAFE MERGE QUEUE = EMPTY. P0 = NO-GO.** Missing physical signed HIGH Broker, same-user process-handle and sandbox witness, ownerEpoch/native dispatch enforcement, and independent durable off-host monotonic atomic CAS. Source success, an inert marker, a Windows Job stdout-drain success, and UI approvals are not a physical OS/Broker/CAS grant. #780 is roadmap scope, not release authorization.

This NEXT4 document records the **observed prior QA24 head**; creating the doc itself advances #852 to a new SHA, and any auto-triggered CI must be reviewed under that *new* SHA. No CI rerun was manually requested and no main merge is authorized.
