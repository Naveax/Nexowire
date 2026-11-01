# PR content evidence — T-254

This read-only Node 22+ script separates product-facing source changes from tools, tests, fixtures, prototypes and documentation based on **changed file paths**. It does not claim that any change was merged, executed in CI or accepted by users.

```bash
node --test-reporter spec scripts/delegated/pool-k14/pr-kind.test.mjs
node scripts/delegated/pool-k14/pr-kind.mjs --offline docs/delegated/integration-k14/pr-1010-1032-rolling.json
```

For new snapshots omit `--offline` and the path; this uses only GitHub REST GETs and refuses a PR HEAD/base that changes during inspection. Optional `GITHUB_TOKEN` is read from environment for rate limits and is never written to the report.

## Historical sample, 2026-11-01 (23 Draft PRs #1010–#1032)

| File-path evidence category | PR count | Meaning |
| --- | ---: | --- |
| `RUNTIME_SOURCE_PRESENT` | 7 | `src/` or `web/` source files changed; runtime feature acceptance is **not** established |
| `TOOLING_PRESENT` | 6 | `scripts/` tooling code changed, but no `src/`/`web/` runtime source change observed |
| `TEST_OR_FIXTURE_ONLY` | 8 | Executable tests/fixtures plus possibly docs; no runtime/tool code observed |
| `DOC_ONLY` | 2 | Only Markdown/text documentation changed |

Total: 23. Tests: **7/7 synthetic PASS**. A `.md` acceptance plan in `test/` is counted as documentation, **not** an executed test. A prototype HTML under `docs/delegated/prototypes/` is **not** treated as deployed application code. Unknown paths or truncated file listings are marked `UNVERIFIED_FILE_SCOPE` rather than guessed.

This is a rolling and potentially stale PR snapshot. To make a merge decision, re-read each exact HEAD, tests, job list, reviews, path/semantic conflicts and branch protections. All sampled upstream workflow runs were blocked with 0 jobs; no code from these PRs was merged on the strength of this classification.
