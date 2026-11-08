# K20 team ownership and evidence audit — 2026-11-07

Tasks **T-371–T-374**. Sources: `ekip/PANO.md` P004 at fork `ekip` commit `a6a62daa569e0adc58f0f6bc2d2a5f8737cdc797`; [#481](https://github.com/Naveax/Nexowire/issues/481) handoff body; live GitHub Pulls API; upstream `main` `4e7db16f4233048a956664bef6b607781eb63fb7`. These are read-only classification results, not owner approval.

## P004 work ownership (20 workers, 120 newly listed tasks)

| Worker | Related issues in P004 | Worker | Related issues in P004 |
| --- | --- | --- | --- |
| K01 | #485, #539 | K11 | #487, #539 |
| K02 | #485, #539 | K12 | #487, #539 |
| K03 | #539, #812 | K13 | #1006, #539 |
| K04 | #539 | K14 | #1006, #539 |
| K05 | #539, #485 | K15 | #539, #812, #485 |
| K06 | #485, #269 | K16 | #539, #540 |
| K07 | #485, #539 | K17 | #780, #539 |
| K08 | #539, #812 | K18 | #487, #588, #539 |
| K09 | #539, #481, #780, #482 | K19 | #588, #539 |
| K10 | #539, #485, #812 | K20 | #539, #540, #1006, #481 |

**Exact/wildcard owned-file-path overlap: 0** from all 20 `ROL/ALAN` declarations in P004. `#539` and `#485` intentionally appear across workers as issue/slice relationships; duplicate issue association is **not** the same as duplicate file ownership. A later PANO revision must be audited anew. `auditTeamBoard` reports paths, tasks and overlaps; injected same-path fixtures trigger a duplicate finding.

## #271 ON HOLD safeguard

[#481](https://github.com/Naveax/Nexowire/issues/481) explicitly says **#271 ON HOLD by user instruction; no ACL remediation until reauthorized**. The 120 P004 task lines contain one textual reference to #271: **K20 T-373**, whose instruction is to *prevent accidental reassignment*, not to perform ACL changes. Result: **0 remediation assignments**, **1 protective audit assignment**. `auditHold271` fails closed if #481's hold evidence is missing, and rejects simulated positive-action tasks for #271. No issue label, state or assignee changed.

## GitHub PR lifecycle, independent integration and CI

The Pulls API `state='closed'` means only closed. **`merged_at`** determines GitHub merge. A closed-unmerged delegated PR may have its *content* independently moved to `main` in a later owner PR, but is never itself "merged". "Superseded" requires exact source/main SHAs, the merged owner PR and verified matching file paths; a matching title or a PANO summary alone is insufficient.

| Example from live Pulls API | API state | Correct claim |
| --- | --- | --- |
| #1031 (`99a76109…`) | closed, `merged_at=null` | CLOSED-UNMERGED; exact content equivalence separate |
| #1032 (`85c4a2bf…`) | closed, `merged_at=null` | CLOSED-UNMERGED |
| #1036 (`5af4a76b…`) | closed, `merged_at=null` | CLOSED-UNMERGED |
| #1039 (`69c51e08…`) | closed, `merged_at=null` | CLOSED-UNMERGED |
| #1066 (`6a899740…`) | closed, `merged_at=2026-11-03T14:58:45Z` | MERGED owner PR |
| #1070 (`90775c70…`) | closed, `merged_at=2026-11-03T22:00:51Z` | MERGED owner PR |
| #1071 (`dc47642d…`) | closed, `merged_at=2026-11-03T21:57:01Z` | MERGED owner PR |
| #1096 (`fe94e204…` at audit) | open, Draft, `merged_at=null` | OPEN Draft, NO-GO; process manager and CORE touched |

`evaluateAcceptance` requires exact CI HEAD and at least one job, all supplied jobs completed/success, and an explicit physical Windows PASS with dated evidence if physical validation is an acceptance requirement. Examples rejected in isolated negative tests: zero jobs, wrong HEAD, skipped/pending/failed jobs, NOT_RUN physical test, simulated Windows PASS, missing evidence. Its `PASS` result on a fabricated unit fixture is **only a classifier unit-test result**, not actual CI or Windows verification. Actual #1096 live CI and physical machine acceptance were **not run by K20**; do not mark #1006 release gate DONE.

## Boundaries

- The source main and PANO are read-only snapshots. Revalidate before merging any PR.
- No owner branch, release workflow, security, Agent process code, protected SQLite/WAL, GitHub issue state, or physical machine was modified.
- K20's audit tests cannot substitute for owner integration, exact-HEAD CI jobs or real Windows/hardware acceptance.
