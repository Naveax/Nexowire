# Fork integration / read-only inventory — K14

Snapshot: 2026-11-01, Europe/Istanbul. GitHub API observations, **not** merge approval.

## Main alignment (T-079)

| Ref | Exact SHA |
| --- | --- |
| `Naveax/Nexowire:main` | `93b6df33ef58610dcfdf3584bfe774e5afa7df4d` |
| `SinsiVinci/Nexowire-fork:main` | `93b6df33ef58610dcfdf3584bfe774e5afa7df4d` |

Result: **IN_SYNC**, zero commits to fast-forward. Fork `main` was not modified. If HEADs differ in a future observation, require a full upstream/fork compare; a missing or ambiguous comparison means `UNKNOWN` and **no ref update**. A future fast-forward requires `force:false` and an `expected_sha` lease on the exact observed fork HEAD.

## Open fork-owned PR ownership and paths (T-080, T-081)

These are the seven fork-owned open PRs returned on 2026-11-01 in the first 100 open upstream PRs; the read-only API listed more upstream PRs, so this table is **not** a claim about all upstream PRs. Every row was separately checked against its own `/pulls/{number}/files` response.

| PR | Author / role | Exact head (short) | Paths | Collision among these 7 |
| --- | --- | --- | --- | --- |
| [#997](https://github.com/Naveax/Nexowire/pull/997) | SinsiVinci, S4/S5 delegated docs+tests | `3bdd96f` | `docs/delegated/S4_*`, `docs/delegated/S5_*`, `scripts/delegated/s5-*`, `test/delegated/s5-*` (8) | None |
| [#998](https://github.com/Naveax/Nexowire/pull/998) | SinsiVinci, S2/S3 delegated UI+docs+tests | `4f11cad` | `docs/delegated/S2_*`, `docs/delegated/S3_*`, `docs/delegated/prototypes/{onboarding,quota-preview}.html`, `scripts/delegated/quota-examples.ts`, related tests (9) | None |
| [#999](https://github.com/Naveax/Nexowire/pull/999) | SinsiVinci, R/REL docs+log redaction | `0910d37` | `docs/delegated/{FINAL_HANDOFF,REL_*,R_*}`, `scripts/delegated/redact-sample-log.ts`, related test (8) | None |
| [#1000](https://github.com/Naveax/Nexowire/pull/1000) | SinsiVinci, K/S1 delegated docs | `fa315e7` | `docs/delegated/{00_*,01_*,02_*,MAIN_TEAM_REQUESTS,S1_*}` (7) | None |
| [#1010](https://github.com/Naveax/Nexowire/pull/1010) | SinsiVinci, K02 CSS | `8a02cbe` | `web/styles.css`, `test/delegated/k02/responsive-css.test.ts` (2) | None |
| [#1011](https://github.com/Naveax/Nexowire/pull/1011) | SinsiVinci, K01 connect UI | `ccbaaff` | `web/connect.html`, `web/connect.js`, `test/delegated/k01/*` (4) | None |
| [#1012](https://github.com/Naveax/Nexowire/pull/1012) | SinsiVinci, K02 newcomer guide | `1121a96` | `docs/delegated/newcomer-k02/README.md` (1) | None |

For #997–#1000, the branch base SHA is `a19a228dc6f19fd484cf935e941a00ea625233f8`. The read-only comparison from that SHA to current main contains 38 commits and 24 changed paths; **none** overlap the 32 (8+9+8+7) paths in those four PRs. For #1010–#1012 the branch base SHA equals current main. Path-disjoint is useful evidence but not a semantic or CI acceptance proof. PRs are still Draft.

## Exact-head upstream CI observations (T-082)

| PR | Exact HEAD | Run | Observed result / jobs |
| --- | --- | --- | --- |
| #997 | `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | [41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | `action_required`, 0 jobs |
| #998 | `4f11cad5f5e8d507270b14de63e9a14ab85c58dc` | [41247357845](https://github.com/Naveax/Nexowire/actions/runs/41247357845) | `action_required`, 0 jobs |
| #999 | `0910d37bd637095eea9934b1bb64f34d3293b4e5` | [41247389846](https://github.com/Naveax/Nexowire/actions/runs/41247389846) | `action_required`, 0 jobs |
| #1000 | `fa315e7e586c8c645fd0d40bd7b9c41ca70b0986` | [41247445037](https://github.com/Naveax/Nexowire/actions/runs/41247445037) | `action_required`, 0 jobs |
| #1010 | `8a02cbe79436021be6b12557b9ea5385ebe2de20` | [41325999493](https://github.com/Naveax/Nexowire/actions/runs/41325999493) | `action_required`, 0 jobs |
| #1011 | `ccbaaff7758769d096c8109e54d697762323f266` | [41326064727](https://github.com/Naveax/Nexowire/actions/runs/41326064727) | `action_required`, 0 jobs |
| #1012 | `1121a966064570cc95ee6088ef8d9bfbca832baf` | [41326227430](https://github.com/Naveax/Nexowire/actions/runs/41326227430) | `action_required`, 0 jobs |

`action_required` + zero jobs **is not PASS**. This is an upstream workflow approval/permission gate for review, not evidence of executed tests. It must be checked afresh after any commit changes. No action was approved or rerun by K14.

## Rebase and merge recommendation (T-083, T-084)

- #997–#1000: no observed *same-path* conflicts against current main, but bases are old and semantic/test compatibility remains `UNKNOWN`. Avoid blanket rebases while the contributing authors own their branches.
- #1010–#1012: based on current main at this snapshot; no cross-PR same-path conflict observed. Their UI and docs implications still require review.
- **Merge-ready list: empty.** All seven Draft PRs have exact-head upstream CI `action_required` with no jobs. No green sequence can be recommended yet. Once owners resolve the gate, re-read exact HEAD, complete jobs, independent review, diff, tests and branch protection. Do not merge on the strength of this report.
- CORE PRs including #1009, #1007, #1005, #1004, #1003, #995, #989 and other native/WAL/auth changes are out of scope; they are not accepted or merged here.

## Repeatable tool (read-only)

Node.js 22 or later, no packages or repository modifications:

```bash
node --test-reporter spec scripts/delegated/k14/integration-report.test.mjs
node scripts/delegated/k14/integration-report.mjs --numbers 997,998,999,1000,1010,1011,1012 --ci
```

The tool uses GitHub REST **GET** requests only, supports optional `GITHUB_TOKEN` for API rate limits, and prints no tokens. It uses pagination caps, checks PR file-list completeness and compares each branch's base SHA to current upstream main. `--json` produces structured output; `--offline file.json` tests a supplied snapshot without network. A live invocation of this CLI was **NOT_RUN** in the restricted test environment; the snapshot above was observed through separate authorized GitHub API reads. Synthetic unit tests are not live GitHub verification.
