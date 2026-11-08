# #539 / T-385 and T-388 — platform and source-evidence boundaries

Source snapshot: upstream `Naveax/Nexowire main` `4e7db16f4233048a956664bef6b607781eb63fb7`, 2026-11-07. K20 made **no** Windows, CORE, Agent, process, installed Stack or authorization change.

## T-385 — run/skip/failure are distinct

| Example | Classification | Why |
| --- | --- | --- |
| `test/process-manager-tree-cleanup.test.ts` with `skip: process.platform !== 'win32'` on Linux | **Windows NOT_RUN** | Linux can parse/report the test but cannot prove Win32 descendants are gone |
| Test runner exits 0 but **all** relevant Windows assertions are skipped | **NOT_RUN** | Zero executed acceptance checks |
| Only some expected checks ran | **PARTIAL** | A green subset cannot certify skipped constraints |
| All TAP assertions report PASS but the test **process exits 1** or hangs | **FAIL** | End-to-end execution includes runner termination, not only assertion counts |
| Synthetic or hosted Windows run exits 0 | **HOSTED/SYNTHETIC REPORTED** | No physical Work-PC acceptance inferred |
| Physical Windows run with matching ownership and dated logs | **PHYSICAL PASS REPORTED, still independently verify** | Exact machine evidence must be inspected by owner |

`platform-proof-audit.mjs` returns `NOT_RUN`, `PARTIAL`, `FAIL`, `INCOMPLETE`, or clearly labelled *reported* PASS. It refuses false PASS for a missing environment or process outcome. The Windows #540 physical descendant/postcondition case is **NOT_RUN by K20**.

## T-388 — real closed PR content found in main, issue still open

Live Pulls API [#1031](https://github.com/Naveax/Nexowire/pull/1031): state `closed`, `merged_at=null`, HEAD `99a76109e69e73c5a835b8ac6e980ee1d2dcb8d5`. Therefore **PR #1031 was NOT GitHub-merged**.

Its `scripts/delegated/k20/triage-open-issues.mjs` changed-file blob SHA reported by GitHub API is **`ecf47f189226ee42f5a1cccfdeb739f023061a71`**. The exact same blob SHA is present in upstream main (`git ls-tree` on the main snapshot). `git log -- .../triage-open-issues.mjs` attributes that main entry to merge commit `b6423b121337723a278a2ba616e8176c1fb5e9b6`; live Pulls API confirms corresponding owner [#1059](https://github.com/Naveax/Nexowire/pull/1059) **merged** at `2026-11-03T09:12:51Z`.

This is a verified example of **identical source content on main by separate owner PR**, **not** source PR #1031 being merged. The reliability umbrella [#539](https://github.com/Naveax/Nexowire/issues/539) is still **open**. Physical Windows or real-device issue acceptance remains **NOT_RUN**.

`issue-source-evidence.mjs` keeps four independent fields: issue state, PR lifecycle, exact source blob equivalence and installed-device acceptance. Tests reject skipped/synthetic device proof and mismatched PR HEAD, and never infer issue resolution merely from identical source. Source equivalence can be narrower than full bug-fix acceptance, even when a later owner commit is merged.
