# K14 — T-390 / issue #1006: 100+ GitHub PR pagination integrity

Captured: 2026-11-07 (Europe/Istanbul). GitHub REST read-only evidence. No PR is merged or approved by this document.

## Reproducible failure and minimal fix

`scripts/delegated/k14/integration-report.mjs` fetches upstream open PRs in 100-item pages (up to six pages). It already refuses a full sixth page rather than silently treating 600 records as a complete inventory. One integrity gap remained: when a PR opens/closes while pages are read sequentially, the same PR number may appear twice across changing page boundaries. A 100-item page followed by a short final page would be marked `complete=true` even if another PR fell out of the inventory.

Reproduction (mocked read-only GitHub API): page 1 contains PR numbers 1–100, page 2 contains 100 and 101–172. The repeated #100 replaces #173; the second page contains only 73 entries, so the old collector returned successfully with a subtly incomplete inventory. **Before the patch**, the duplicate-boundary assertion failed because `collectSnapshot()` did not reject this input.

The fix is local to K14's report collector: after pagination and before classifying PRs, reject duplicate or invalid PR numbers and require a fresh read from page 1. A counted short terminal page remains necessary. This is a detection guard, **not a guarantee of atomic GitHub pagination**; boundary shifts that do not create a duplicate remain possible. The existing exact-HEAD recheck of selected source PRs is retained.

## Real upstream snapshot, not a device acceptance

The current `Naveax/Nexowire` public REST open-PR endpoint was read with `state=open&per_page=100`:

| Page | Count | First PR | Last PR |
| --- | ---: | ---: | ---: |
| 1 | 100 | #1118 | #932 |
| 2 | 100 | #931 | #778 |
| 3 | 100 | #777 | #677 |
| 4 | 73 | #676 | #551 |
| 5 (extra terminal probe) | 0 | — | — |

373 numbers observed; 373 unique; strictly descending in this rolling read. Separate GitHub issue search at observation also reported 373 open PRs. This observation establishes **why a single 100-item page would silently undercount**, but is not a transactional proof of every PR during concurrent changes.

## Regression results

Run against the same source tree:

```bash
node --test --test-reporter spec scripts/delegated/k14/integration-report.test.mjs scripts/delegated/k14/pagination-integrity.test.mjs
node --check scripts/delegated/k14/integration-report.mjs
```

**17/17 local offline tests PASS**: eleven existing integration regressions plus six pagination tests (101, 373, exact 100, >600 fail-closed, duplicate boundary failure, page-two HTTP failure). The duplicate case was observed FAIL before this source fix and PASS after it. Node syntax check PASS. Hosted exact-HEAD CI is independent and must be checked on the new PR/commit. Windows/Work-PC/2-PC/provider tests: **NOT_RUN**, not necessary for a read-only pagination guard.

Issue: [#1006](https://github.com/Naveax/Nexowire/issues/1006). Scope: only `scripts/delegated/k14/**`, `docs/delegated/integration-k14/**`; no CORE, Broker, security, WAL, workflow, publish, merge or issue-close operations.
