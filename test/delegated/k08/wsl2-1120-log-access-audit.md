# D-126 — #1120 WSL2 failure evidence and log availability

Read-only snapshot **2026-11-09**, P007/V006. Source PR
[#1120](https://github.com/Naveax/Nexowire/pull/1120) is still open Draft at
exact SHA `f6ae93d8746f5b753618cbbb5f1f1b2a73ef2090`. Its only
GitHub PR-triggered [CI run 42411741316](https://github.com/Naveax/Nexowire/actions/runs/42411741316)
has status `completed`, conclusion **`failure`**. **No rerun** or
workflow/source change was made.

## Exact run/job observations

| Evidence | GitHub observation | Safe interpretation |
| --- | --- | --- |
| [Run 42411741316](https://github.com/Naveax/Nexowire/actions/runs/42411741316) | 7 jobs returned: **6 success, 1 failure** | Required CI **FAIL** for this HEAD; six other green jobs do not override WSL failure. |
| [`wsl2-live` job 128521158395](https://github.com/Naveax/Nexowire/actions/runs/42411741316/job/128521158395) | `completed/failure` | Real Windows runner acceptance **failed**, not PASS. |
| Setup + checkout + Node setup | First three normal job steps show `success` | Runner/job started and checked out source; it was not a 0-job workflow. |
| `Install real Ubuntu WSL2 distro` | Step status `in_progress`, conclusion **null** in API's *completed* job snapshot | Failure happened **at or before completing the distro-provisioning stage**. `null` is not a real test assertion failure and does not prove exact underlying cause. |
| `npm ci`, `npm run typecheck`, `Verify Nexowire wsl.exec against real WSL2` | All subsequent steps show `pending`, conclusion **null** | **NOT_RUN**. No basis to attribute the failure to Nexowire's `wsl.exec` assertion or typecheck. |
| Job log endpoint | `fetch_workflow_job_logs(128521158395)` returns **HTTP 404, BlobNotFound** | Actual runner stdout/stderr unavailable from this API now. Exact failure message and root cause **UNKNOWN**; do not invent a GitHub outage, action bug or source regression. |
| Run artifacts | `fetch_workflow_run_artifacts(42411741316)` returns an empty list | No uploaded diagnostic artifact available to inspect; not evidence that the runner had no internal logs. |

At this PR's exact source, `.github/workflows/ci.yml` blob
`90185b6f4297bc3e4feaca44817ed6a8248bd4be`, lines 251–271,
defines `wsl2-live` on `windows-latest`, Node 24, and pins
`Vampire/setup-wsl@d1da7f2c0322a5ee4f24975344f67fc0f5baf364` with
`distribution: Ubuntu-24.04`, `wsl-version: 2`, `use-cache: "true"`.
Only **after** that provisioning does it run `npm ci`, typecheck, and
`node --test --import tsx test/wsl-live.test.ts` with the live WSL flag.
K08 inspected this workflow **read-only**; neither the job definition nor
WSL implementation was edited.

## Cross-run control, not a root-cause claim

On the newer K13 [#1149 exact run 42514702344](https://github.com/Naveax/Nexowire/actions/runs/42514702344),
the same named `wsl2-live` job, ID `128835055028`, **completed/success**.
Its `Install real Ubuntu WSL2 distro`, `npm ci`, typecheck and real WSL2
test steps all explicitly report success. This demonstrates the same
provisioning/test workflow **can** complete on another commit/run, but does
**not** prove why the earlier #1120 run failed. #1120 remains red until its
own exact HEAD is legitimately revalidated under maintainer-controlled CI;
the team rule forbids duplicate rerun of an already-worked exact SHA.

## Owner handoff

1. **K16 and Ömer / #1096 CI owner:** inspect repository Actions' native
   failure annotation or retained runner logs for job 128521158395, if
   available to a maintainer. The API log archive **404** is a real access
   blocker; do not misclassify it as a code failure.
2. **K14 / #1153 inventory owner:** keep #1120 at **1 failed + 6 successful
   jobs**, not among all-green merge candidates. Future independent source
   changes can generate their own CI run, but no forced retry/CI bypass by K08.
3. **Acceptance:** the previous run did **not** exercise the WSL integration
   test. Later different-HEAD green WSL jobs are useful comparison, **not**
   retroactive acceptance at #1120's SHA. Physical owner device, Hub/Agent,
   real provider and installed binary validation for #539/#540/#812 remain
   **NOT_RUN** in this K08 report.

This is a bounded log/access and phase-triage result for P007 D-126, not a
fix to protected CI or Windows runtime. No new PR, main merge, issue close,
workflow rerun, credential use or physical machine operation was performed.
