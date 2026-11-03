# Exact-head PR summary (HAVUZ T-140)

Conservative, read-only acceptance evidence for a **single PR**. No merge, review, approval, git push or secret logging. Node 22+, zero third-party dependencies.

```bash
node --test-reporter spec scripts/delegated/pr-summary-k14/pr-summary.test.mjs
node scripts/delegated/pr-summary-k14/pr-summary.mjs --repo Naveax/Nexowire --pr 1022
```

Use `--json` for machine-readable output, or `--offline snapshot.json` for an injected fixture with no network. `GITHUB_TOKEN` is optional for GitHub rate limits; do not put it in arguments or commit it.

The script reads PR metadata *before and after* pulling files and workflow runs, to detect changed head/base SHAs. It checks file-list pagination, exact-head run association, nonempty job lists, pending/action_required conclusions, and conservative sensitive-path flags. Even when observed jobs are all green, the result stays `NOT_APPROVED_FOR_MERGE`: reviews, branch protections, exact checkout semantics and physical/Windows acceptance require separate checks. GitHub's mergeable flag is descriptive, not permission.

Snapshot 2026-11-01 Europe/Istanbul, separately observed through authorized GitHub API reads:

- Draft [#1022](https://github.com/Naveax/Nexowire/pull/1022) at head `c90efc23ee55d941818d5dc5c442391ce6c89387`, base `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`, 3 files.
- [Workflow run 41326747422](https://github.com/Naveax/Nexowire/actions/runs/41326747422): same HEAD, `action_required`, **0 jobs**. No CI pass claim.
- Local synthetic unit tests: 6/6 PASS. Live command-line GitHub fetch: NOT_RUN in restricted environment; this snapshot came from separate API inspection.
