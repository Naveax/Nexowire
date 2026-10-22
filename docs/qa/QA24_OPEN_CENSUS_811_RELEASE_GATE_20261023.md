# NEXOWIRE #24: full open-PR DAG / Git executor #811 and P0 release-gate QA
**Captured 2026-10-23. DRAFT, source/docs/QA only. PRODUCTION P0 NO-GO.**

## Proven, and not proven

- **Previous #810** exact HEAD `0ef7e6290bbb5bb64d4b6a01839ff33c252eb7f7`, exact primary CI `39843615134` **SUCCESS**.
- The user's earlier authoritative direct GitHub GET `/pulls?state=open&per_page=100` returned **210+**. **The current connected GitHub date-partitioned search returned 232 OPEN PR IDs**, split 14/89/41/88/0, repeated **twice with exactly identical IDs**, no window at the 100-result cap. This is a *point-in-time* and **not** a direct live GET `/pulls` run in this session. Source file: `docs/qa/fixtures/qa24-open-id-census-20261023.json`.
- Historic source-verified `#24` detailed DAG was **202 nodes** at previous PR. **The 232-ID census lacks 30+ new full file/CI/compare records**, so it is inaccurate to call 232 entries fully inspected or claim a current no-collision merge list. Every new PR, changing HEAD/base, changing CI outcome and main SHA can invalidate a pinned table.
- Existing `scripts/qa24-live-dag.ts` already gathers **all** OPEN PRs using authoritative GitHub GET `/pulls?state=open&per_page=100&page=N`, collects **every** changed-file page, exact-head primary CI, true SHA merge-base, and then **double-reads every open HEAD/base and main SHA**, failing closed if the source moves during capture. New `scripts/qa24-full-merge-gate-811.ts` wraps it in a non-authorizing P0 release gate and emits JSON. This **full external-REST collector was NOT run against a live GH_TOKEN in this conversation**. Hermetic hostile tests cover the full live path, including 232 entries and 100+100+32 two-pass pagination. No fabricated claims of 232 HEAD/CI attestations.

## Directly re-queried exact-head cross-owner CI / merge-base

| PR | Exact HEAD prefix | Primary CI run | Status and blocker |
|---|---|---|---|
| #810 | `0ef7e6290bbb` | `39843615134` | **SUCCESS**, QA source, not release proof |
| #811 | `600a0286557d` | `39854971347` | **SUCCESS**, Git executor source, original hostile tests **unproven unchanged** |
| #708 | `36b443ef300d` | `39824007092` | **FAILURE**, **DIVERGED** merge-base `437030d2…` vs base `e7e46b97…` |
| #726 | `50491525249b` | `39823764746` | **FAILURE**, CORE approval UI negative |
| #786 | `8d5390dc8ed9` | `39817020745` | **FAILURE**, original worktree-root escape negative |
| #800 | `6eb562cffd68` | `39823730640` | **FAILURE**, original fsmonitor hook escape negative |
| #801 | `6742ddfceb34` | `39823885977` | SUCCESS, but owns `.github/workflows/ci.yml` shared across other PRs |
| #802 | `12c7511bdeb9` | `39824624827` | **FAILURE**, independent QA and shared `.github/workflows/ci.yml` |

**#811 files**: `src/agent/executors.ts`, `test/p20-780-git-fsmonitor-hook-escape-negative.test.ts`, `test/p26-780-git-worktree-root-escape-negative.test.ts`. **#786** and **#800** respectively change the same *test files*. That is an independent-owner path collision, and #811's exact CI SUCCESS does **not** establish that **byte-identical original #786/#800 negative tests** were run unmodified against #811 production executor in isolated disposable checkout. #20, #26, #31 independent owner handoff required. Do not weaken original assertions to make the red tests green.

#801/#802 have an independent-branch owner collision on `.github/workflows/ci.yml`. Source greens, such as #801, do not resolve workflow or P0 owner authority. Earlier #609/#622 stale parent and #776 unresolved parent remain historical blockers until an entirely current graph is proven.

## New full-release P0 gate, even when GitHub source becomes entirely green

`scripts/qa24-full-merge-gate-811.ts` uses the existing full exact HEAD/CI/file/compare collector and revalidates:

- Full OPEN coverage and exact HEAD CI at the same SHA; unknown/queued/red cannot be green.
- Parent chain, stale parent, red ancestor and unresolved branch, baseline main and merge-base `ahead` condition.
- Independent changed-file collisions, including #811↔#786 and #811↔#800 original adversarial tests and #801↔#802 workflow ownership.
- **Mandatory external physical witnesses**: independently atomic two-Hub CAS/revoke and original mutation identity; protected signed native HIGH Broker/OS token + ACL/PID/FILETIME; immutable signed Artifact final publication/writer-stop; independently verified Windows physical acceptance.

This analyzer **always** returns `gate: NO_GO`, `production_merge_authorized: false`, `current_safe_merge_queue: []`, including after *every* source CI turns green, because source PASS is not physical/cryptographic production acceptance. A complete snapshot still needs #00 security/code-owner review, branch protection and physical sign-off. **#780 is P1 product roadmap epic, not a mergeable P0 PR.**

`test/qa-24-full-merge-gate-811.test.ts` builds **synthetic** 232 OPEN PRs with 100/100/32 REST pages, all 232 complete file lists and exact-head workflow/compare calls, then double-reads every PR head and main ref. It checks torn open set/HEAD, missing CI, incomplete changed paths, bad SHA merge-base, source GREEN false-positive and critical independent owner collisions. These are **tests of collector/gate logic**, not proof that live GitHub currently has 232 exact green records.

## Reproduce (authorized read-only environment)

```sh
node --test --import tsx test/qa-24-full-merge-gate-811.test.ts
# Optional only with GitHub READ-ONLY token on approved isolated QA runner:
GH_TOKEN=<read-only-token> node --import tsx scripts/qa24-full-merge-gate-811.ts Naveax/Nexowire > qa24-full-verified.json
# Intentionally exits 2 even for complete source evidence: production remains NO-GO
```

**#00 SAFE SOURCE-ONLY MERGE QUEUE: EMPTY**. Not safe to merge #811, #801, #802, #708 or any unverified PR. **No merge, CI same-SHA rerun, Agent 1.0.5, Broker/UAC/ACL, D1, VM, user files, or ReVoltVPN-Ubuntu-Lab actions were performed.**
