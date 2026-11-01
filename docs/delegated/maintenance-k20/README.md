# Non-core issue and test maintenance — K20

Snapshot: **2026-11-01** (Europe/Istanbul), upstream source `Naveax/Nexowire` at
`93b6df33ef58610dcfdf3584bfe774e5afa7df4d`. The issue inventory is an
API observation, **not** evidence of a released feature or a permanently stable
GitHub state. No source security/core/runtime, billing or deployment file is
modified by these maintenance tools.

## T-115 — Open issue triage (read-only)

Source: public GitHub `/repos/Naveax/Nexowire/issues?state=open&per_page=100`
pages 1–4, inspected on 2026-11-01. GitHub's `/issues` API also includes pull
requests; the tool removes them using `pull_request`, validates canonical issue
URLs, and deduplicates repeated issue numbers. Observed sample:

- **23** distinct open issues; **355** PR entries excluded; **0** repeated issue
  records (results can change as PRs are opened/closed).
- **14** CORE/auth/billing/release/process-control issues are blocked from K20
  implementation; **3** parent/index trackers are not separate tasks.
- **6** issue references yielded **5** unique non-core-only slices. Existing
  assignments are recognized; none is independently ready for new coding by K20.

| Non-core slice | Issue references | Duplication / safe owner |
| --- | --- | --- |
| Status wording audit | [#812](https://github.com/Naveax/Nexowire/issues/812) | K15 T-085–T-090; no grant/auth changes |
| Reviewed-diff UX acceptance notes | [#780](https://github.com/Naveax/Nexowire/issues/780) | Ask ŞEF to assign a docs-only scope; no sandbox/Git authority changes |
| Transfer user-state regression | [#588](https://github.com/Naveax/Nexowire/issues/588) | K19 T-109–T-114; no transport/auth changes |
| Offline cost/capacity evidence | [#487](https://github.com/Naveax/Nexowire/issues/487) | K11/K12/K18 already own S5 measurements; no duplicate work |
| Windows setup/recovery guidance | [#485](https://github.com/Naveax/Nexowire/issues/485), [#269](https://github.com/Naveax/Nexowire/issues/269) | **One** K06 T-031–T-036 slice; signed installer/pairing out of scope |

Excluded umbrella/index issues: #539, #482, #481. All other issue bodies require
CORE or owner controls, even where they contain a tempting UI/documentation
subtask. The classifier defaults unknown issue IDs to `review`, never `candidate`.

To regenerate from a **saved, unmodified** API response (single JSON array or
array of page arrays), without network access:

```sh
node scripts/delegated/k20/triage-open-issues.mjs --input issue-pages.json
```

No API result or token is written by this CLI. Network collection is intentionally
left outside the tool; pagination completeness must be checked by the operator.

## T-116 — Markdown documentation link checks

```sh
node scripts/delegated/k20/check-doc-links.mjs --root .
```

On the upstream baseline plus K20 additions, the latest scan inspected **260
Markdown files**, **69** local links, skipped **824** external/site routes,
and found **0** missing local targets/headings. External URLs were **not**
verified. Scope: README and `docs/` by default; supports simple inline Markdown
links, local file paths and GitHub-like heading anchors. This is **not** a full
CommonMark parser; reference-style links, arbitrary HTML and browser route
semantics are not established by this scan. Symlink traversal outside the repo
is rejected, and code fences are ignored.

## T-117 — Test ownership/collision inventory

```sh
node scripts/delegated/k20/test-ownership.mjs .
```

Observed upstream baseline plus K20 test files at latest scan: **462** test file
paths, **0** repeated basenames. Delegated directory `test/delegated/kNN/**`
provides explicit ownership; tests outside it remain `upstream/unassigned`.
Equal basenames in different paths would be a **review hint**, not proof of a
Git conflict. Re-run after other agents land new tests; do not infer ownership
from filenames or overwrite unassigned upstream tests.

## T-118 — Honest typecheck/build/test status separation

```sh
node scripts/delegated/k20/command-status.mjs
```

By default, each package script is discovered independently and explicitly
reported `NOT_RUN`. Opt-in `--run` executes `npm run typecheck`, `npm run build`
and `npm run test` as separate steps with 120-second bounds; `PASS`, `FAIL`,
`TIMEOUT` and `NOT_RUN` remain distinct. The status classifier has isolated
negative tests. Full repo checks were **NOT_RUN** in this pass: this worktree
has no installed `node_modules`, and sandbox child process creation returned
`EPERM` when simulated. There is no CI or Windows acceptance claim.

## T-119 — PR review evidence summary

```sh
node scripts/delegated/k20/pr-evidence.mjs
node scripts/delegated/k20/pr-evidence.mjs --input review-metadata.json
```

The optional JSON supports `scope`, `branch`, exact 40-character `sha`/`base`,
`tests` entries (`name`, `status`, `details`), `outstanding` and `security`.
Unknown check statuses and abbreviated SHAs fail validation. Empty evidence
stays `NOT_RUN` and `NOT_RECORDED`, never silently `PASS`.

## T-120 — User-scenario regression catalog

```sh
node scripts/delegated/k20/regression-catalog.mjs
```

`scenarios.json` currently lists five **Draft** non-core PR user scenarios
(connection retry, responsive focus, admin announcements, setup guidance and MCP
documentation). These are pending review/merge/real-device verification, not
completed product features. The renderer requires an exact merge SHA plus
evidence before any row can be marked `MERGED_VERIFIED`; the catalog must be
re-checked after each actual merge. No completed release scenario is asserted.

## Reproducible local tests

```sh
node --test test/delegated/k20/*.test.mjs
```

The six standalone test files cover positive and negative input cases, including
PR-as-issue exclusion, de-duplicated onboarding scope, unknown issue fail-closed,
missing/escaping links, owner path collisions, unavailable child process,
evidence statuses and false merge claims. Static/synthetic checks do **not**
substitute for live device, authenticated GitHub CI, browser/Windows or deployment
acceptance.
