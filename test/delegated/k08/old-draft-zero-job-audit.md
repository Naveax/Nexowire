# Six historic 0-job Draft PRs — read-only D-134 evidence

Evidence captured 2026-11-08, P007/V006. No new PR, CI re-dispatch, workflow
mutation, critical-source edit, upstream merge or issue closure. The six PRs
remain **open Drafts** against `Naveax/Nexowire:main`. Their exact HEAD CI
runs are all `completed/action_required` with **zero returned job records**;
none passed an automated test on those runs.

| PR / owner | Exact unchanged PR HEAD | Existing CI run | Source-specific disposition |
| --- | --- | --- | --- |
| [#1010](https://github.com/Naveax/Nexowire/pull/1010), K02 | `3f6a226e4244d3a599d9631adf69bb40bf1f4c92` | [41337736249](https://github.com/Naveax/Nexowire/actions/runs/41337736249), **0 job** | `web/styles.css` is also owner #1068 integration territory. Preserve original responsive fixtures; K02/owner compares hunks, not an unreviewed merge. |
| [#1011](https://github.com/Naveax/Nexowire/pull/1011), K01 | `6e740dfe919e5f615655f68815b078447915ce6f` | [41337712422](https://github.com/Naveax/Nexowire/actions/runs/41337712422), **0 job** | Existing PR description reports four byte-identical paths in #1068; K01 verifies original QA coverage before close recommendation. |
| [#1015](https://github.com/Naveax/Nexowire/pull/1015), K04 | `2d448f69a996feeefcfa4b657af7f5249ba94681` | [41338010341](https://github.com/Naveax/Nexowire/actions/runs/41338010341), **0 job** | `web/admin.js`/`.html` belong to owner #1068; preserve admin a11y test separately before integration decision. |
| [#1016](https://github.com/Naveax/Nexowire/pull/1016), K03 | `96fa340b477915dc95dd4d8275c981b0a3b37f89` | [41337745754](https://github.com/Naveax/Nexowire/actions/runs/41337745754), **0 job** | `web/app.js`/`.html` owned by #1068; K03 first reconciles panel-state tests with latest owner UI. |
| [#1030](https://github.com/Naveax/Nexowire/pull/1030), K17 | `bc97cd84c7b224cdfe140a77a7f9200d6bcf50e4` | [41338216468](https://github.com/Naveax/Nexowire/actions/runs/41338216468), **0 job** | Includes protected `src/skills` and distinct K17 offline tests; no K08 editing. Escalate to K17/#1150 owner, especially current symlink acceptance. |
| [#1035](https://github.com/Naveax/Nexowire/pull/1035), K08 | `e0de00624b1de3c0564ebc37e2c50ae914259a4f` | [41338306321](https://github.com/Naveax/Nexowire/actions/runs/41338306321), **0 job** | Unique MCP redaction fixture 5 local PASS / 1 security-owner TODO; **not** safe to discard, and 0-job is not CI coverage. Keep as separate owner review or transfer complete unique QA before any close decision. |

## Workflow / branch evidence, not a guessed root cause

For **all six exact PR HEAD commits**, GitHub Contents returns the **same**
complete `.github/workflows/ci.yml` Git blob
`b1bb5b50e047b452c15200dafcac80c9f5888eb8` (6,822 bytes when fetched
unabridged on #1035). Its YAML **has `pull_request`, `workflow_dispatch`,
`jobs.test`, and a Node 22/24 matrix**. They were not inherently zero-job
workflow definitions. The current upstream
`main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` has a **different**
CI blob `90185b6f4297bc3e4feaca44817ed6a8248bd4be`, with additional delegated
test steps. Thus a modern green main or unrelated PR does not retroactively
prove that these six old PR commits were tested.

The GitHub Actions API reports `conclusion: action_required` and no job records
for each exact run. This is **compatible with an approval/permission gate**,
but the available run/job metadata does **not** expose a definitive reason;
do not assert that an approval requirement, code bug, YAML syntax error or
runner outage was conclusively found. No log exists for a job that did not
start. Review the repository's actual Actions approval/request UI and current
branch policy with a GitHub maintainer if an owner elects to continue one of
these PRs. Do not bypass permission gates or re-dispatch the same exact commit
merely to make the dashboard green.

## Handoff — exact scope before accepting a close or integration

1. **K01–K04 / owner #1068:** compare the old `web/` hunks and preserve unique
   offline source regressions; do not merge old web source blindly. K01 has a
   documented byte-identical owner overlap; the other three need their own
   source-level reconciliation.
2. **K17 / owner #1150:** preserve K17's unique manifest/metadata tests;
   protected skill-loader/symlink changes are not K08's edit territory.
3. **K08 / #1035:** same-source local redaction QA is 5 PASS / 1 TODO,
   and cookie diagnostic reachability is unresolved. K08's cleaner #1106
   32/32 PASS neither exercises these unique fixtures nor cures the historic
   0-job. Transfer the unique test and README only with owner review; close
   #1035 only after evidence preservation and explicit ŞEF/Ömer decision.

New required-CI *test discovery* is a separate gap: #1106
[run 42485671743](https://github.com/Naveax/Nexowire/actions/runs/42485671743)
and the audit-only next HEAD
[run 42500920781](https://github.com/Naveax/Nexowire/actions/runs/42500920781)
both have 7/7 generic success but do not select the new nested K08 `.mjs` files.
An old 0-job state and a later green job missing tests are **different**
failures. The latest [#1106](https://github.com/Naveax/Nexowire/pull/1106)
audit-only followup commit also has no physical Windows/Hub/Agent/provider
acceptance. None of these six PRs has a demonstrated live end-to-end result
from this report.
